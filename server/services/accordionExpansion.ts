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
 * Returns a deduplication key for a candidate element.
 * Priority: aria-controls → data-target → data-bs-target → closest ancestor [id].
 * Elements that control the same collapse target are functionally identical —
 * only the first one encountered should be clicked.
 * Returns '' for elements with no identifiable target (always included).
 */
async function getCollapseTargetKey(el: ElementHandle<Element>): Promise<string> {
  return el.evaluate((node) => {
    const e = node as HTMLElement;
    const direct =
      e.getAttribute('aria-controls') ||
      e.getAttribute('data-target') ||
      e.getAttribute('data-bs-target');
    if (direct) return `target:${direct}`;
    const container = e.closest('[id]');
    return container ? `container:${(container as HTMLElement).id}` : '';
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
 * Visibility is checked via `element.checkVisibility()` (Chromium 105+), which
 * correctly returns false for links hidden inside `height:0; overflow:hidden`
 * collapsed containers — unlike `offsetParent !== null` which returns true
 * for those elements even when they are invisible to the user.
 * Falls back to `offsetParent !== null` on older browsers.
 */
async function snapshotVisibleLinks(page: Page): Promise<string[]> {
  return page.$$eval('a[href]', (els) =>
    (els as HTMLAnchorElement[]).filter((a) => {
      if (typeof (a as any).checkVisibility === 'function') {
        return (a as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      return a.offsetParent !== null;
    }).map((a) => a.href)
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
 *     (aria-controls / data-target / data-bs-target) before clicking, so
 *     ancestor+descendant matches from overlapping selectors do not produce
 *     double-clicks on the same section.
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

    // Deduplicate by collapse target so ancestor+descendant selector matches
    // for the same accordion section are not clicked twice.
    const seenTargets = new Set<string>();
    const candidates: ElementHandle<Element>[] = [];
    for (const el of rawCandidates) {
      const key = await getCollapseTargetKey(el);
      if (key && seenTargets.has(key)) continue;
      if (key) seenTargets.add(key);
      candidates.push(el);
    }

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
        console.log(`[Accordion] skip (not clickable): "${text.substring(0, 80)}": ${msg.split('\n')[0]}`);
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
