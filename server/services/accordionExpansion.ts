import type { Page } from 'playwright';
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
 * Given an already-loaded Playwright `page` (pointing at the town homepage),
 * finds collapsed accordion elements whose header text matches a
 * document-relevant trigger word, clicks each one, then returns all
 * same-hostname `<a href>` values that became visible after expansion.
 *
 * Visibility is checked via `offsetParent !== null` so that links already
 * present in the DOM but hidden by CSS (Bootstrap collapse pattern) are
 * correctly captured — not only links dynamically inserted into the DOM.
 *
 * The browser lifecycle (open / close in `finally`) is the caller's
 * responsibility. This function only operates on the provided `page`.
 *
 * The entire body is wrapped in a top-level try/catch; any unexpected failure
 * logs `[Accordion] pass failed: <message>` and returns an empty array so the
 * caller's crawl is never aborted.
 */
export async function expandAccordionSections(
  page: Page,
  baseHostname: string
): Promise<string[]> {
  try {
    const visibleBefore = new Set<string>(
      await page.$$eval('a[href]', (els) =>
        (els as HTMLAnchorElement[])
          .filter((a) => a.offsetParent !== null)
          .map((a) => a.href)
      )
    );

    const candidates = await page.$$(ACCORDION_SELECTORS);

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
        console.log(`[Accordion] timeout on ${text.substring(0, 80)}: ${msg}`);
      }
    }

    if (expandedCount === 0) {
      console.log('[Accordion] No matching accordion sections found');
      return [];
    }

    const visibleAfter = await page.$$eval('a[href]', (els) =>
      (els as HTMLAnchorElement[])
        .filter((a) => a.offsetParent !== null)
        .map((a) => a.href)
    );

    const revealed: string[] = [];
    const seen = new Set<string>();
    for (const href of visibleAfter) {
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
