import type { Page, ElementHandle } from 'playwright';
import { execSync } from 'child_process';

const TRIGGER_WORDS = [
  'news', 'announcements', 'updates', 'results', 'latest',
  'agendas', 'minutes', 'warrants', 'notices', 'meetings',
];

const DOM_SETTLE_MS = 3000;

const ACCORDION_SELECTORS = [
  // HTML5 native — always correct
  'details:not([open]) summary',

  // ARIA — framework-agnostic, works everywhere accessibility standards are followed
  '[aria-expanded="false"]',
  '[role="tab"]:not([aria-expanded="true"])',
  '[role="button"][aria-controls]:not([aria-expanded="true"])',

  // Bootstrap 4 / 5 data-attribute triggers (BS5 uses data-bs-*, BS4 uses data-*)
  '[data-bs-toggle="collapse"]',
  '[data-bs-toggle="tab"]',
  '[data-toggle="collapse"]',
  '[data-toggle="tab"]',

  // Bootstrap 5 accordion button (added by the framework alongside aria-expanded)
  '.accordion-button',

  // Bootstrap 3 / legacy patterns kept for backward compatibility
  '.panel-heading',
  '.accordion-toggle',
  '.collapsed',
].join(', ');

function containsTriggerWord(text: string): boolean {
  const lower = text.toLowerCase();
  return TRIGGER_WORDS.some(w => lower.includes(w));
}

/**
 * Computes a stable deduplication key and a "hasDirect" flag for a candidate
 * element in a single browser-side evaluate call.
 *
 * Key resolution order:
 *   1. Own direct target attributes (aria-controls / data-target / data-bs-target)
 *      → `target:<id>`  (hasDirect = true)
 *   2. Closest nested descendant trigger's target — covers the common case where
 *      a parent container element (.panel-heading) and its child clickable trigger
 *      ([data-toggle="collapse"]) both match selectors. Without this step they
 *      would get different keys and both be clicked.
 *      → `target:<id>`  (hasDirect = false — prefers inner trigger at click time)
 *   3. Closest ancestor with an [id] attribute → `container:<id>` (hasDirect = false)
 *   4. No identifier found → '' (element is always kept, no deduplication applied)
 *
 * When two candidates share the same key, the one with hasDirect=true is
 * preferred (kept), because it is the actual clickable trigger rather than
 * a non-interactive container wrapper.
 */
async function getCollapseInfo(
  el: ElementHandle<Element>
): Promise<{ key: string; hasDirect: boolean }> {
  return el.evaluate((node) => {
    const e = node as HTMLElement;

    // 1. Own direct target
    const ownTarget =
      e.getAttribute('aria-controls') ||
      e.getAttribute('data-target') ||
      e.getAttribute('data-bs-target');
    if (ownTarget) {
      return { key: `target:${ownTarget.replace(/^#/, '')}`, hasDirect: true };
    }

    // 2. Nested descendant trigger (e.g., .panel-heading wrapping [data-toggle="collapse"])
    const inner = e.querySelector<HTMLElement>(
      '[aria-controls], [data-target], [data-bs-target]'
    );
    if (inner) {
      const innerTarget =
        inner.getAttribute('aria-controls') ||
        inner.getAttribute('data-target') ||
        inner.getAttribute('data-bs-target');
      if (innerTarget) {
        return { key: `target:${innerTarget.replace(/^#/, '')}`, hasDirect: false };
      }
    }

    // 3. Closest ancestor id as fallback
    const container = e.closest('[id]');
    if (container) {
      return { key: `container:${(container as HTMLElement).id}`, hasDirect: false };
    }

    return { key: '', hasDirect: false };
  });
}

export function getSystemChromiumPath(): string | undefined {
  try {
    const result = execSync(
      'which chromium-browser 2>/dev/null || which chromium 2>/dev/null || echo ""',
      { timeout: 3000, encoding: 'utf8' }
    ).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Snapshot all `<a href>` values that are currently visible on the page.
 *
 * Visibility is checked via `element.checkVisibility()` (standard DOM API,
 * typed in TypeScript's lib.dom since TS 5.3, available in Chromium 105+).
 * This correctly returns false for links hidden inside `height:0; overflow:hidden`
 * collapsed containers — unlike `offsetParent !== null` which returns true for
 * those elements even when invisible to the user.
 */
async function snapshotVisibleLinks(page: Page): Promise<string[]> {
  return page.$$eval('a[href]', (els) =>
    (els as HTMLAnchorElement[])
      .filter((a) => a.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      .map((a) => a.href)
  );
}

/**
 * Given an already-loaded Playwright `page` (pointing at the town homepage,
 * loaded at mobile viewport 390×844), finds collapsed accordion elements whose
 * header text matches a document-relevant trigger word, clicks each one, then
 * returns all same-hostname `<a href>` values that became visible after
 * expansion.
 *
 * Three correctness improvements over earlier versions:
 *  1. Deduplication — candidates are deduplicated by their collapse target
 *     (aria-controls / data-target / data-bs-target), resolving the key from
 *     nested descendants when the matching element itself lacks the attribute.
 *     This handles the ancestor+descendant overlap (e.g., .panel-heading wrapping
 *     [data-toggle="collapse"]) that previously caused double-clicks. When two
 *     candidates share a key, the one with a direct target attribute is preferred.
 *  2. Mobile viewport — the caller (crawlerEngine) loads the page at 390×844,
 *     where CMS accordion patterns are present in the DOM (responsive design
 *     often hides them on desktop).
 *  3. Visibility via checkVisibility() — `height:0; overflow:hidden` hidden
 *     links no longer appear in the "before" snapshot, so they correctly show
 *     up as newly revealed after expansion.
 *
 * The browser lifecycle is the caller's responsibility.
 * The entire body is wrapped in a top-level try/catch; any unexpected failure
 * logs `[Accordion] pass failed: <message>` and returns [] so the crawl is
 * never aborted.
 */
export async function expandAccordionSections(
  page: Page,
  baseHostname: string
): Promise<string[]> {
  try {
    const visibleBefore = new Set<string>(await snapshotVisibleLinks(page));

    const rawCandidates = await page.$$(ACCORDION_SELECTORS);

    // Deduplicate: build a map from collapse-target key to the best candidate.
    // "Best" means hasDirect=true (direct target attribute) over hasDirect=false
    // (parent container or container-id fallback), so we click the actual trigger.
    type CandidateEntry = { el: ElementHandle<Element>; hasDirect: boolean };
    const keyed = new Map<string, CandidateEntry>();
    const noKey: ElementHandle<Element>[] = [];

    for (const el of rawCandidates) {
      const { key, hasDirect } = await getCollapseInfo(el);
      if (!key) {
        noKey.push(el);
        continue;
      }
      const existing = keyed.get(key);
      if (!existing) {
        keyed.set(key, { el, hasDirect });
      } else if (hasDirect && !existing.hasDirect) {
        keyed.set(key, { el, hasDirect });
      }
    }

    const candidates: ElementHandle<Element>[] = [
      ...Array.from(keyed.values()).map((v) => v.el),
      ...noKey,
    ];

    let expandedCount = 0;
    for (const candidate of candidates) {
      let text = '';
      try {
        text = (await candidate.innerText()).trim();
      } catch {
        continue;
      }
      if (!containsTriggerWord(text)) continue;

      try {
        await candidate.click({ timeout: DOM_SETTLE_MS });
        await page.waitForTimeout(DOM_SETTLE_MS);
        expandedCount++;
        console.log(`[Accordion] Expanded: "${text.substring(0, 80)}"`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `[Accordion] skip (not clickable): "${text.substring(0, 80)}": ${msg.split('\n')[0]}`
        );
      }
    }

    if (expandedCount === 0) {
      console.log('[Accordion] No matching accordion sections found');
      return [];
    }

    const visibleAfterArr = await snapshotVisibleLinks(page);

    const revealed: string[] = [];
    const seen = new Set<string>();
    for (const href of visibleAfterArr) {
      if (visibleBefore.has(href) || seen.has(href)) continue;
      seen.add(href);
      try {
        const u = new URL(href);
        if (u.hostname === baseHostname && u.protocol.startsWith('http')) {
          revealed.push(href);
        }
      } catch {
      }
    }

    console.log(
      `[Accordion] expanded ${expandedCount} section(s), revealed ${revealed.length} new URL(s)`
    );
    return revealed;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Accordion] pass failed: ${msg}`);
    return [];
  }
}
