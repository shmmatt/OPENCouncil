import { chromium as playwrightChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { type Browser, type BrowserContext } from 'playwright';
import { execSync } from 'child_process';

playwrightChromium.use(StealthPlugin());

function findChromiumPath(): string {
  try {
    const path = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (path) return path;
  } catch {}
  
  try {
    const nixPaths = execSync('ls /nix/store/*/bin/chromium 2>/dev/null | head -1', { encoding: 'utf-8' }).trim();
    if (nixPaths) return nixPaths;
  } catch {}

  return '/usr/bin/chromium';
}

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
const BROWSER_TIMEOUT = 30000;
const PAGE_TIMEOUT = 25000;
const CF_CHALLENGE_WAIT = 20000;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  browserLaunchPromise = playwrightChromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || findChromiumPath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  });

  try {
    browserInstance = await browserLaunchPromise;
    browserInstance.on('disconnected', () => {
      browserInstance = null;
      browserLaunchPromise = null;
    });
    return browserInstance;
  } catch (e) {
    browserLaunchPromise = null;
    throw e;
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try { await browserInstance.close(); } catch {}
    browserInstance = null;
    browserLaunchPromise = null;
  }
}

export interface BrowserFetchResult {
  html: string;
  status: number;
  finalUrl: string;
  wasChallenged: boolean;
  challengeResolved: boolean;
}

export async function browserFetchPage(
  url: string,
  options?: { timeout?: number; waitForSelector?: string }
): Promise<BrowserFetchResult | null> {
  let context: BrowserContext | null = null;
  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      javaScriptEnabled: true,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      (window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    const timeout = options?.timeout || PAGE_TIMEOUT;
    let wasChallenged = false;
    let challengeResolved = false;

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    const initialTitle = await page.title();
    const initialContent = await page.content();
    const hasCfChallenge = initialTitle.includes('Just a moment') ||
      initialContent.includes('challenge-platform') ||
      initialContent.includes('cf-challenge');

    if (hasCfChallenge) {
      wasChallenged = true;
      try {
        await page.waitForFunction(
          () => !document.title.includes('Just a moment') && 
                !document.querySelector('#challenge-running') &&
                !document.querySelector('.cf-challenge'),
          { timeout: CF_CHALLENGE_WAIT }
        );
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
        await page.waitForTimeout(2000);
        challengeResolved = true;
      } catch {
        challengeResolved = false;
      }
    }

    if (options?.waitForSelector) {
      try {
        await page.waitForSelector(options.waitForSelector, { timeout: 5000 });
      } catch {}
    }

    await page.waitForTimeout(1000);

    const html = await page.content();
    const finalUrl = page.url();
    const status = response?.status() || 200;

    const stillBlocked = html.includes('Just a moment') || html.includes('challenge-platform');
    if (wasChallenged && stillBlocked) {
      challengeResolved = false;
    }

    return { html, status, finalUrl, wasChallenged, challengeResolved };
  } catch (e: any) {
    console.error(`[BrowserFetch] Error fetching ${url}: ${e.message}`);
    return null;
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

export async function browserFetchDocument(
  url: string,
  referer?: string
): Promise<{ buffer: Buffer; contentType: string; size: number } | null> {
  let context: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept': 'application/pdf,application/vnd.openxmlformats-officedocument.*,*/*',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
      },
    });

    const page = await context.newPage();

    const downloadPromise = new Promise<{ buffer: Buffer; contentType: string } | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), BROWSER_TIMEOUT);

      page.route('**/*', async (route) => {
        const request = route.request();
        if (request.url() === url || request.url().startsWith(url.split('?')[0])) {
          try {
            const response = await route.fetch();
            const body = await response.body();
            const headers = response.headers();
            clearTimeout(timeout);
            resolve({
              buffer: body,
              contentType: headers['content-type'] || 'application/octet-stream',
            });
          } catch {
            clearTimeout(timeout);
            resolve(null);
          }
        } else {
          route.continue();
        }
      });
    });

    if (referer) {
      await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    await page.goto(url, { waitUntil: 'commit', timeout: BROWSER_TIMEOUT }).catch(() => {});

    const result = await downloadPromise;
    if (!result || result.buffer.length < 100) return null;

    return { buffer: result.buffer, contentType: result.contentType, size: result.buffer.length };
  } catch {
    return null;
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

export async function isBrowserAvailable(): Promise<boolean> {
  try {
    const browser = await getBrowser();
    return browser.isConnected();
  } catch {
    return false;
  }
}
