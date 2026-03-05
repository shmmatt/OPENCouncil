import { logInfo, logWarn, logError } from '../utils/logger';

const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
const JINA_READER_BASE = 'https://r.jina.ai/';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  fullText?: string;
}

export function isWebSearchConfigured(): boolean {
  return BRAVE_SEARCH_API_KEY.length > 0;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function braveSearch(query: string, maxResults: number = 3): Promise<Array<{ title: string; url: string; snippet: string }>> {
  if (!BRAVE_SEARCH_API_KEY) {
    logWarn('brave_search_not_configured', { message: 'BRAVE_SEARCH_API_KEY not set, skipping web search' });
    return [];
  }

  const params = new URLSearchParams({
    q: query,
    count: String(maxResults),
    text_decorations: 'false',
    search_lang: 'en',
  });

  try {
    const response = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_SEARCH_API_KEY,
        },
      },
      15000
    );

    if (!response.ok) {
      logError('brave_search_error', { status: response.status, statusText: response.statusText });
      return [];
    }

    const data = await response.json() as any;
    const results = (data.web?.results || []).slice(0, maxResults);

    return results.map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
    }));
  } catch (error: any) {
    if (error.name === 'AbortError') {
      logError('brave_search_timeout', { query });
    } else {
      logError('brave_search_failed', { query, error: error.message });
    }
    return [];
  }
}

async function fetchPageViaJina(url: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(
      `${JINA_READER_BASE}${url}`,
      {
        headers: {
          'Accept': 'text/plain',
        },
      },
      20000
    );

    if (!response.ok) {
      logWarn('jina_fetch_failed', { url, status: response.status });
      return null;
    }

    const text = await response.text();
    const trimmed = text.slice(0, 5000);
    return trimmed;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      logWarn('jina_fetch_timeout', { url });
    } else {
      logWarn('jina_fetch_error', { url, error: error.message });
    }
    return null;
  }
}

export async function searchWeb(query: string, maxResults: number = 3): Promise<WebSearchResult[]> {
  logInfo('web_search_started', { query, maxResults });

  const searchResults = await braveSearch(query, maxResults);

  if (searchResults.length === 0) {
    logInfo('web_search_no_results', { query });
    return [];
  }

  const enrichedResults: WebSearchResult[] = await Promise.all(
    searchResults.map(async (result) => {
      const fullText = await fetchPageViaJina(result.url);
      return {
        ...result,
        fullText: fullText || undefined,
      };
    })
  );

  logInfo('web_search_complete', {
    query,
    resultCount: enrichedResults.length,
    withFullText: enrichedResults.filter(r => r.fullText).length,
  });

  return enrichedResults;
}
