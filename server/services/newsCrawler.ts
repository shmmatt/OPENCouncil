import type { TownFeedNewsArticle } from '../../shared/schema';
import { logInfo, logWarn, logError } from '../utils/logger';

interface NewsSource {
  name: string;
  baseUrl: string;
  rssUrls: string[];
  searchUrlTemplate?: string;
}

const NEWS_SOURCES: NewsSource[] = [
  {
    name: 'Conway Daily Sun',
    baseUrl: 'https://www.conwaydailysun.com',
    rssUrls: [
      'https://www.conwaydailysun.com/search/?f=rss&t=article&c=news&l=50&s=start_time&sd=desc',
      'https://www.conwaydailysun.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc',
      'https://www.conwaydailysun.com/feed/',
      'https://www.conwaydailysun.com/rss/',
    ],
    searchUrlTemplate: 'https://www.conwaydailysun.com/search/?q={query}&f=rss',
  },
  {
    name: 'Carroll County Independent',
    baseUrl: 'https://www.carrollcountyindependent.com',
    rssUrls: [
      'https://www.carrollcountyindependent.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc',
      'https://www.carrollcountyindependent.com/feed/',
      'https://www.carrollcountyindependent.com/rss/',
    ],
    searchUrlTemplate: 'https://www.carrollcountyindependent.com/search/?q={query}&f=rss',
  },
  {
    name: 'Laconia Daily Sun',
    baseUrl: 'https://www.laconiadailysun.com',
    rssUrls: [
      'https://www.laconiadailysun.com/search/?f=rss&t=article&c=news&l=50&s=start_time&sd=desc',
      'https://www.laconiadailysun.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc',
      'https://www.laconiadailysun.com/feed/',
      'https://www.laconiadailysun.com/rss/',
    ],
    searchUrlTemplate: 'https://www.laconiadailysun.com/search/?q={query}&f=rss',
  },
];

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

function extractRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];

  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const linkMatch = block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
    const descMatch = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
    const pubDateMatch = block.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i);

    const title = (titleMatch?.[1] || '').trim();
    const link = (linkMatch?.[1] || '').trim();
    const description = (descMatch?.[1] || '').trim();
    const pubDate = (pubDateMatch?.[1] || '').trim();

    if (title && link) {
      items.push({
        title: stripHtml(title),
        link,
        description: stripHtml(description).slice(0, 500),
        pubDate: pubDate || undefined,
      });
    }
  }

  if (items.length === 0) {
    const entryBlocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const block of entryBlocks) {
      const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const linkMatch = block.match(/<link[^>]*href="([^"]*)"[^>]*\/?\s*>/i) ||
                         block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
      const summaryMatch = block.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i) ||
                           block.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i);
      const updatedMatch = block.match(/<updated>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/updated>/i) ||
                           block.match(/<published>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/published>/i);

      const title = (titleMatch?.[1] || '').trim();
      const link = (linkMatch?.[1] || linkMatch?.[2] || '').trim();
      const description = (summaryMatch?.[1] || '').trim();
      const pubDate = (updatedMatch?.[1] || '').trim();

      if (title && link) {
        items.push({
          title: stripHtml(title),
          link,
          description: stripHtml(description).slice(0, 500),
          pubDate: pubDate || undefined,
        });
      }
    }
  }

  return items;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topicMatchesItem(topic: string, item: RssItem): boolean {
  const topicLower = topic.toLowerCase();
  const keywords = topicLower
    .split(/[\s,;:]+/)
    .filter(w => w.length > 3)
    .filter(w => !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been', 'will', 'about', 'their', 'would', 'could', 'should'].includes(w));

  if (keywords.length === 0) return false;

  const searchText = `${item.title} ${item.description}`.toLowerCase();

  let matchCount = 0;
  for (const kw of keywords) {
    if (searchText.includes(kw)) {
      matchCount++;
    }
  }

  const matchRatio = matchCount / keywords.length;
  return matchRatio >= 0.3 || matchCount >= 2;
}

async function fetchRss(url: string, timeoutMs = 10000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OpenCouncil/1.0; +https://opencouncil.app)',
        'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timer);

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();

    if (text.includes('<rss') || text.includes('<feed') || text.includes('<channel') || 
        contentType.includes('xml') || contentType.includes('rss')) {
      return text;
    }

    return null;
  } catch (e: any) {
    logWarn('rss_fetch_failed', { url, error: e.message });
    return null;
  }
}

async function fetchViaJinaReader(url: string, timeoutMs = 15000): Promise<string | null> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(jinaUrl, {
      headers: {
        'Accept': 'text/plain',
        'User-Agent': 'Mozilla/5.0 (compatible; OpenCouncil/1.0)',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timer);

    if (!res.ok) return null;
    return await res.text();
  } catch (e: any) {
    logWarn('jina_reader_failed', { url, error: e.message });
    return null;
  }
}

function extractArticlesFromText(text: string, sourceName: string, topic: string): TownFeedNewsArticle[] {
  const articles: TownFeedNewsArticle[] = [];
  const topicLower = topic.toLowerCase();
  const keywords = topicLower
    .split(/[\s,;:]+/)
    .filter(w => w.length > 3)
    .filter(w => !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been', 'will', 'about'].includes(w));

  const lines = text.split('\n');
  let currentTitle = '';
  let currentUrl = '';
  let currentSnippet = '';

  for (const line of lines) {
    const trimmed = line.trim();

    const linkMatch = trimmed.match(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/);
    if (linkMatch) {
      if (currentTitle && currentUrl) {
        const combined = `${currentTitle} ${currentSnippet}`.toLowerCase();
        const matchCount = keywords.filter(kw => combined.includes(kw)).length;
        if (matchCount >= 1) {
          articles.push({
            title: currentTitle,
            url: currentUrl,
            source: sourceName,
            snippet: currentSnippet.slice(0, 300) || currentTitle,
            fetchedAt: new Date().toISOString(),
          });
        }
      }
      currentTitle = linkMatch[1].trim();
      currentUrl = linkMatch[2].trim();
      currentSnippet = '';
    } else if (trimmed.startsWith('# ') || trimmed.startsWith('## ')) {
      if (currentTitle && currentUrl) {
        const combined = `${currentTitle} ${currentSnippet}`.toLowerCase();
        const matchCount = keywords.filter(kw => combined.includes(kw)).length;
        if (matchCount >= 1) {
          articles.push({
            title: currentTitle,
            url: currentUrl,
            source: sourceName,
            snippet: currentSnippet.slice(0, 300) || currentTitle,
            fetchedAt: new Date().toISOString(),
          });
        }
      }
      currentTitle = trimmed.replace(/^#+\s*/, '');
      currentUrl = '';
      currentSnippet = '';
    } else if (trimmed && currentTitle) {
      if (currentSnippet.length < 300) {
        currentSnippet += (currentSnippet ? ' ' : '') + trimmed;
      }
    }
  }

  if (currentTitle && currentUrl) {
    const combined = `${currentTitle} ${currentSnippet}`.toLowerCase();
    const matchCount = keywords.filter(kw => combined.includes(kw)).length;
    if (matchCount >= 1) {
      articles.push({
        title: currentTitle,
        url: currentUrl,
        source: sourceName,
        snippet: currentSnippet.slice(0, 300) || currentTitle,
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  return articles;
}

async function searchSourceViaRss(
  source: NewsSource,
  topic: string
): Promise<TownFeedNewsArticle[]> {
  const articles: TownFeedNewsArticle[] = [];
  const seenUrls = new Set<string>();

  if (source.searchUrlTemplate) {
    const searchUrl = source.searchUrlTemplate.replace('{query}', encodeURIComponent(topic));
    const xml = await fetchRss(searchUrl);
    if (xml) {
      const items = extractRssItems(xml);
      for (const item of items) {
        if (!seenUrls.has(item.link)) {
          seenUrls.add(item.link);
          articles.push({
            title: item.title,
            url: item.link,
            source: source.name,
            snippet: item.description || item.title,
            fetchedAt: new Date().toISOString(),
          });
        }
      }
      if (articles.length > 0) {
        logInfo('rss_search_success', { source: source.name, topic, count: articles.length });
        return articles;
      }
    }
  }

  for (const rssUrl of source.rssUrls) {
    const xml = await fetchRss(rssUrl);
    if (!xml) continue;

    const items = extractRssItems(xml);
    if (items.length === 0) continue;

    logInfo('rss_feed_fetched', { source: source.name, url: rssUrl, itemCount: items.length });

    for (const item of items) {
      if (topicMatchesItem(topic, item) && !seenUrls.has(item.link)) {
        seenUrls.add(item.link);
        articles.push({
          title: item.title,
          url: item.link,
          source: source.name,
          snippet: item.description || item.title,
          fetchedAt: new Date().toISOString(),
        });
      }
    }

    if (articles.length > 0) break;
  }

  return articles;
}

async function searchSourceViaFallback(
  source: NewsSource,
  topic: string
): Promise<TownFeedNewsArticle[]> {
  const searchUrl = `${source.baseUrl}/search/?q=${encodeURIComponent(topic)}`;
  logInfo('fallback_jina_search', { source: source.name, searchUrl });

  const content = await fetchViaJinaReader(searchUrl);
  if (!content) return [];

  return extractArticlesFromText(content, source.name, topic);
}

export async function searchNewsForTopic(
  topic: string,
  sources: NewsSource[] = NEWS_SOURCES
): Promise<TownFeedNewsArticle[]> {
  logInfo('news_search_started', { topic, sourceCount: sources.length });

  const allArticles: TownFeedNewsArticle[] = [];
  const seenUrls = new Set<string>();

  for (const source of sources) {
    try {
      let articles = await searchSourceViaRss(source, topic);

      if (articles.length === 0) {
        logInfo('rss_no_results_trying_fallback', { source: source.name, topic });
        articles = await searchSourceViaFallback(source, topic);
      }

      for (const article of articles) {
        if (!seenUrls.has(article.url)) {
          seenUrls.add(article.url);
          allArticles.push(article);
        }
      }

      logInfo('news_source_complete', {
        source: source.name,
        topic,
        articlesFound: articles.length,
      });
    } catch (e: any) {
      logError('news_source_error', {
        source: source.name,
        topic,
        error: e.message,
      });
    }
  }

  logInfo('news_search_complete', {
    topic,
    totalArticles: allArticles.length,
  });

  return allArticles;
}

export async function searchNewsForTopics(
  topics: string[]
): Promise<Map<string, TownFeedNewsArticle[]>> {
  const results = new Map<string, TownFeedNewsArticle[]>();

  for (const topic of topics) {
    const articles = await searchNewsForTopic(topic);
    results.set(topic, articles);
  }

  return results;
}

export function getConfiguredNewsSources(): { name: string; baseUrl: string }[] {
  return NEWS_SOURCES.map(s => ({ name: s.name, baseUrl: s.baseUrl }));
}
