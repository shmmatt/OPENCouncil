import type { Page } from 'playwright';
import { execSync } from 'child_process';

const TRIGGER_WORDS = [
  'news', 'announcements', 'updates', 'results', 'latest',
  'agendas', 'minutes', 'warrants', 'notices', 'meetings',
];

const DOM_SETTLE_MS = 3000;

const ACCORDION_SELECTORS = [
  'details:not([open]) summary',
  '[aria-expanded="false"]',
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

export interface AccordionResult {
  urls: string[];
  expandedCount: number;
}

/**
 * Given an already-loaded Playwright `page` (pointing at the town homepage),
 * finds collapsed accordion elements whose header text matches a
 * document-relevant trigger word, clicks each one, then returns all
 * same-hostname `<a href>` values that were NOT visible before expansion.
 *
 * Visibility is checked via `offsetParent !== null` so that links already
 * present in the DOM but hidden by the collapsed state are correctly
 * included — not just links that are dynamically added to the DOM.
 *
 * The browser lifecycle (open / close in `finally`) is the caller's
 * responsibility. This function only operates on the provided `page`.
 */
export async function expandAccordionSections(
  page: Page,
  baseHostname: string
): Promise<AccordionResult> {
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
    } catch (e: any) {
      console.log(`[Accordion] timeout on "${text.substring(0, 80)}": ${e.message}`);
    }
  }

  if (expandedCount === 0) {
    console.log('[Accordion] No matching accordion sections found');
    return { urls: [], expandedCount: 0 };
  }

  const visibleAfter = await page.$$eval('a[href]', (els) =>
    (els as HTMLAnchorElement[])
      .filter((a) => a.offsetParent !== null)
      .map((a) => a.href)
  );

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const href of visibleAfter) {
    if (visibleBefore.has(href) || seen.has(href)) continue;
    seen.add(href);
    try {
      const u = new URL(href);
      if (u.hostname === baseHostname && u.protocol.startsWith('http')) {
        urls.push(href);
      }
    } catch {
    }
  }

  console.log(`[Accordion] expanded ${expandedCount} section(s), revealed ${urls.length} new URL(s)`);
  return { urls, expandedCount };
}
