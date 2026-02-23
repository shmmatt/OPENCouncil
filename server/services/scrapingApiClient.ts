const SCRAPING_API_KEY = process.env.SCRAPING_API_KEY || '';
const SCRAPING_API_BASE = process.env.SCRAPING_API_BASE || 'https://api.zenrows.com/v1/';

export function isScrapingApiConfigured(): boolean {
  return SCRAPING_API_KEY.length > 0;
}

export interface ScrapingPageResult {
  html: string;
  status: number;
  headers: Record<string, string>;
  finalUrl: string;
  cookies: string[];
}

export interface ScrapingDocResult {
  buffer: Buffer;
  contentType: string;
  size: number;
}

export async function fetchPageViaAPI(
  url: string,
  options?: { js_render?: boolean; timeout?: number }
): Promise<ScrapingPageResult | null> {
  if (!isScrapingApiConfigured()) return null;

  try {
    const params = new URLSearchParams({
      apikey: SCRAPING_API_KEY,
      url,
      ...(options?.js_render ? { js_render: 'true', wait: '5000' } : {}),
    });

    const controller = new AbortController();
    const timeoutMs = options?.timeout || 60000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${SCRAPING_API_BASE}?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
    });
    clearTimeout(timeoutId);

    const cookies: string[] = [];
    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
      cookies.push(...setCookieHeader.split(',').map(c => c.trim().split(';')[0]));
    }
    const zenrowsCookies = response.headers.get('Zr-Cookies');
    if (zenrowsCookies) {
      try {
        const parsed = JSON.parse(zenrowsCookies);
        if (Array.isArray(parsed)) {
          cookies.push(...parsed.map((c: any) => `${c.name}=${c.value}`));
        }
      } catch {}
    }

    const html = await response.text();

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      html,
      status: response.status,
      headers: responseHeaders,
      finalUrl: responseHeaders['zr-final-url'] || url,
      cookies,
    };
  } catch (e: any) {
    console.error(`[ScrapingAPI] Error fetching page ${url}: ${e.message}`);
    return null;
  }
}

export async function fetchDocumentViaAPI(
  url: string,
  cookies?: string[]
): Promise<ScrapingDocResult | null> {
  if (!isScrapingApiConfigured()) return null;

  try {
    const params = new URLSearchParams({
      apikey: SCRAPING_API_KEY,
      url,
    });

    if (cookies && cookies.length > 0) {
      params.set('custom_headers', 'true');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const headers: Record<string, string> = {
      'Accept': 'application/pdf,application/octet-stream,*/*',
    };
    if (cookies && cookies.length > 0) {
      headers['Cookie'] = cookies.join('; ');
    }

    const response = await fetch(`${SCRAPING_API_BASE}?${params.toString()}`, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`[ScrapingAPI] Document fetch failed: HTTP ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 100) return null;

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    return { buffer, contentType, size: buffer.length };
  } catch (e: any) {
    console.error(`[ScrapingAPI] Error fetching document ${url}: ${e.message}`);
    return null;
  }
}

export function fetchDocumentWithCookies(
  url: string,
  cookies: string[],
  signal?: AbortSignal
): Promise<{ buffer: Buffer; contentType: string; size: number } | null> {
  return new Promise(async (resolve) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      if (signal) {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Cookie': cookies.join('; '),
          'Accept': 'application/pdf,application/octet-stream,*/*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        redirect: 'follow',
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        resolve(null);
        return;
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      if (contentType.includes('text/html')) {
        resolve(null);
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length < 100) {
        resolve(null);
        return;
      }

      resolve({ buffer, contentType, size: buffer.length });
    } catch {
      resolve(null);
    }
  });
}

export function extractFinalUrlFromInterstitial(html: string): string | null {
  const metaRefresh = html.match(/content=["']\d+;\s*url=(.*?)["']/i);
  if (metaRefresh) return metaRefresh[1];

  const windowLocation = html.match(/window\.location(?:\.href)?\s*=\s*["'](.*?)["']/i);
  if (windowLocation) return windowLocation[1];

  const windowReplace = html.match(/window\.location\.replace\(["'](.*?)["']\)/i);
  if (windowReplace) return windowReplace[1];

  const downloadLink = html.match(/href=["'](.*?\.(?:pdf|docx?|xlsx?|pptx?|csv|zip))["']/i);
  if (downloadLink) return downloadLink[1];

  return null;
}
