import { chromium } from 'playwright';
import { execSync } from 'child_process';

const TRIGGER_WORDS = [
  'news', 'announcements', 'updates', 'results', 'latest',
  'agendas', 'minutes', 'warrants', 'notices', 'meetings',
];

const DOM_SETTLE_MS = 3000;
const PAGE_LOAD_TIMEOUT_MS = 15000;
const INITIAL_SETTLE_MS = 1500;

function containsTriggerWord(text: string): boolean {
  const lower = text.toLowerCase();
  return TRIGGER_WORDS.some(w => lower.includes(w));
}

function getSystemChromiumPath(): string | undefined {
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

const ACCORDION_SELECTORS = [
  'details:not([open]) summary',
  '[aria-expanded="false"]',
  '.panel-heading',
  '.accordion-toggle',
  '.collapsed',
].join(', ');

/**
 * Loads `url` in a headless Playwright browser, finds collapsed accordion
 * elements whose visible header text matches a document-relevant trigger word,
 * clicks each one, then returns all same-hostname `<a href>` values that were
 * NOT present in the DOM before the expansion.
 *
 * Constraints enforced:
 * - Only called on seed URLs (caller's responsibility).
 * - 3-second DOM-settle timeout per accordion click.
 * - Entire function is wrapped in try/catch; any failure returns [].
 * - Browser is always closed in a finally block.
 */
export async function expandAccordionSections(
  url: string,
  baseHostname: string
): Promise<string[]> {
  const revealedUrls: string[] = [];
  let browser = null;

  try {
    const executablePath = getSystemChromiumPath();
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
    } catch (e: any) {
      console.log(`[Accordion] Page load failed for ${url}: ${e.message}`);
      return revealedUrls;
    }

    await page.waitForTimeout(INITIAL_SETTLE_MS);

    const linksBefore = new Set<string>(
      await page.$$eval('a[href]', (els) =>
        els.map((a) => (a as HTMLAnchorElement).href)
      )
    );

    const candidates = await page.$$(ACCORDION_SELECTORS);

    let expanded = 0;
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
        expanded++;
        console.log(`[Accordion] Expanded: "${text.substring(0, 80)}"`);
      } catch (e: any) {
        console.log(`[Accordion] timeout on "${text.substring(0, 80)}": ${e.message}`);
      }
    }

    if (expanded === 0) {
      console.log(`[Accordion] No matching accordion sections found on ${url}`);
      return revealedUrls;
    }

    const linksAfter = await page.$$eval('a[href]', (els) =>
      els.map((a) => (a as HTMLAnchorElement).href)
    );

    for (const href of linksAfter) {
      if (linksBefore.has(href)) continue;
      try {
        const u = new URL(href);
        if (u.hostname === baseHostname && u.protocol.startsWith('http')) {
          revealedUrls.push(href);
        }
      } catch {
      }
    }

    console.log(
      `[Accordion] ${url}: expanded ${expanded} section(s), revealed ${revealedUrls.length} new URL(s)`
    );
  } catch (e: any) {
    console.log(`[Accordion] pass failed: ${e.message}`);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }

  return revealedUrls;
}
