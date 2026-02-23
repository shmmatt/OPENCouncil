import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';
import { db } from '../storage/db';
import { crawlerDocuments, crawlerTowns, crawlerRuns } from '../../shared/crawler-schema';
import type { CrawlerTown, CrawlerRun, CrawlRunSummary, FailureType } from '../../shared/crawler-schema';
import { classifyError } from '../../shared/crawler-schema';
import { eq, sql } from 'drizzle-orm';
import {
  generateS3Key,
  extractFilename,
  extractDocumentMetadata,
} from './crawlerStateExtensions';
import { hashUrl, recordDocument } from './crawlerState';
import { browserFetchPage, browserFetchDocument, closeBrowser, isBrowserAvailable } from './browserFetcher';

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

const USER_AGENT = USER_AGENTS[0];

function getRandomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBrowserHeaders(ua: string, refererUrl?: string): Record<string, string> {
  const isChrome = ua.includes('Chrome') && !ua.includes('Edg');
  const isFirefox = ua.includes('Firefox');
  const isEdge = ua.includes('Edg');
  const isSafari = ua.includes('Safari') && !ua.includes('Chrome');

  const headers: Record<string, string> = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  };

  if (refererUrl) {
    headers['Referer'] = refererUrl;
    try {
      headers['Origin'] = new URL(refererUrl).origin;
    } catch {}
  }

  if (isChrome || isEdge) {
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = refererUrl ? 'same-origin' : 'none';
    headers['Sec-Fetch-User'] = '?1';
    headers['Sec-CH-UA'] = isEdge
      ? '"Microsoft Edge";v="122", "Chromium";v="122", "Not(A:Brand";v="24"'
      : '"Google Chrome";v="120", "Chromium";v="120", "Not_A Brand";v="8"';
    headers['Sec-CH-UA-Mobile'] = '?0';
    headers['Sec-CH-UA-Platform'] = ua.includes('Windows') ? '"Windows"' : ua.includes('Mac') ? '"macOS"' : '"Linux"';
  }

  if (isFirefox) {
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = refererUrl ? 'same-origin' : 'none';
    headers['Sec-Fetch-User'] = '?1';
    headers['DNT'] = '1';
  }

  if (isSafari) {
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  }

  return headers;
}

function getDocDownloadHeaders(ua: string, refererUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': ua,
    'Accept': 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/octet-stream,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': refererUrl,
  };

  try {
    headers['Origin'] = new URL(refererUrl).origin;
  } catch {}

  if (ua.includes('Chrome')) {
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = 'same-origin';
    headers['Sec-Fetch-User'] = '?1';
  }

  return headers;
}

const protectedDomains = new Map<string, { protection: string; detectedAt: number; extraDelay: number }>();

function getDomainFromUrl(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function markDomainProtected(url: string, protection: string) {
  const domain = getDomainFromUrl(url);
  protectedDomains.set(domain, {
    protection,
    detectedAt: Date.now(),
    extraDelay: protection === 'cloudflare' ? 3000 : protection === 'akamai' ? 4000 : 2000,
  });
}

function getDomainDelay(url: string): number {
  const domain = getDomainFromUrl(url);
  const info = protectedDomains.get(domain);
  if (!info) return 0;
  if (Date.now() - info.detectedAt > 3600000) {
    protectedDomains.delete(domain);
    return 0;
  }
  return info.extraDelay;
}

const activeCrawls = new Map<string, CrawlJob>();

export interface CrawlProgress {
  runId: string;
  townId: string;
  townName: string;
  status: 'running' | 'completed' | 'failed';
  pagesVisited: number;
  pagesQueued: number;
  documentsDiscovered: number;
  documentsDownloaded: number;
  documentsFailed: number;
  duplicatesSkipped: number;
  currentUrl: string;
  log: string[];
  startedAt: Date;
  completedAt?: Date;
  errorMessage?: string;
  detectedCms?: string;
  strategyStats?: StrategyStats;
  protectionDetected?: string;
}

interface StrategyStats {
  sitemap: number;
  knownPaths: number;
  breadthFirst: number;
  external: number;
  iframe: number;
}

interface FoundDocument {
  url: string;
  linkText: string;
  foundOnPage: string;
  strategy: keyof StrategyStats;
}

interface CrawlJob {
  progress: CrawlProgress;
  abortController: AbortController;
}

type CmsType = 'CivicPlus' | 'WordPress' | 'Revize' | 'Squarespace' | 'Custom' | null;

function detectCmsFromHtml(html: string, url: string): CmsType {
  const lower = html.toLowerCase();

  if (lower.includes('civicplus') || lower.includes('civiccms') ||
      lower.includes('/agendacenter') || lower.includes('/documentcenter') ||
      lower.includes('cpn-') || lower.includes('civic-plus')) {
    return 'CivicPlus';
  }
  if (lower.includes('wp-content') || lower.includes('wp-includes') ||
      lower.includes('wordpress') || lower.includes('wp-json')) {
    return 'WordPress';
  }
  if (lower.includes('revize') || lower.includes('revize.com')) {
    return 'Revize';
  }
  if (lower.includes('squarespace') || lower.includes('static1.squarespace')) {
    return 'Squarespace';
  }
  return 'Custom';
}

function detectProtection(html: string): string | null {
  const lower = html.toLowerCase();
  if (lower.includes('just a moment') && (lower.includes('cloudflare') || lower.includes('checking your browser'))) {
    return 'cloudflare';
  }
  if (lower.includes('akamai') && (lower.includes('access denied') || lower.includes('bot manager'))) {
    return 'akamai';
  }
  if (lower.includes('captcha') || lower.includes('recaptcha') || lower.includes('hcaptcha')) {
    return 'captcha';
  }
  if (lower.includes('incapsula') || lower.includes('imperva')) {
    return 'imperva';
  }
  return null;
}

function isDocumentUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.csv', '.txt'];
  if (docExts.some(ext => lower.endsWith(ext) || lower.includes(ext + '?') || lower.includes(ext + '#'))) return true;

  if (lower.includes('/viewfile/')) return true;
  if (lower.includes('/agendacenter/viewfile/')) return true;
  if (lower.includes('/documentcenter/view/')) return true;
  if (lower.includes('/formcenter/view/')) return true;

  if (lower.includes('/wp-content/uploads/')) return true;

  if (lower.match(/\/(documents?|files?|downloads?)\//)) return true;
  if (lower.match(/\/download\//)) return true;

  if (lower.includes('/blobserver/')) return true;
  if (lower.includes('getfile') || lower.includes('viewdocument')) return true;

  return false;
}

function isExternalDocumentLink(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('drive.google.com') && (lower.includes('/file/') || lower.includes('/open?'))) return true;
  if (lower.includes('docs.google.com') && lower.includes('/document/')) return true;
  if (lower.includes('dropbox.com') && (lower.includes('/s/') || lower.includes('/scl/'))) return true;
  if (lower.includes('onedrive.live.com') || lower.includes('1drv.ms')) return true;
  if (lower.includes('sharepoint.com') && lower.includes('/Documents/')) return true;
  return false;
}

function isNavigationLink(url: string, baseHostname: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== baseHostname) return false;
    if (u.hash && !u.pathname) return false;
    if (url.startsWith('javascript:')) return false;
    if (url.startsWith('mailto:')) return false;
    if (url.startsWith('tel:')) return false;
    if (isDocumentUrl(url)) return false;

    const skipPatterns = [
      '/search', '/login', '/account', '/cart', '/checkout',
      '/register', '/signup', '/forgot-password', '/reset-password',
      '/wp-login', '/wp-admin', '/xmlrpc', '/feed',
      '/calendar/month', '/calendar/week', '/calendar/day',
      '/print/', '/email/', '/share/',
      '.css', '.js', '.json', '.xml', '.rss', '.ico', '.svg',
      '.png', '.jpg', '.jpeg', '.gif', '.webp',
    ];
    const pathLower = u.pathname.toLowerCase();
    if (skipPatterns.some(p => pathLower.includes(p))) return false;

    return true;
  } catch {
    return false;
  }
}

function isHighPriorityUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return /agenda|document|form|meeting|minute|board|committee|selectm|planning|zoning|conservation|budget|ordinance|warrant|report|annual/.test(lower);
}

function normalizeUrl(url: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(url, baseUrl);
    resolved.hash = '';
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url).hostname.replace(/^www\./, '');
    const b = new URL(baseUrl).hostname.replace(/^www\./, '');
    return a === b;
  } catch {
    return false;
  }
}

async function s3KeyExists(s3: S3Client, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadToS3(s3: S3Client, key: string, buffer: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
}

function extractLinksFromHtml(html: string, pageUrl: string): Array<{ href: string; text: string }> {
  const links: Array<{ href: string; text: string }> = [];
  const linkRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, '').trim();
    const resolved = normalizeUrl(href, pageUrl);
    if (resolved) {
      links.push({ href: resolved, text });
    }
  }
  return links;
}

function extractIframeAndEmbedSrcs(html: string, pageUrl: string): string[] {
  const urls: string[] = [];

  const iframeRegex = /<iframe\s[^>]*src=["']([^"']+)["']/gi;
  let m;
  while ((m = iframeRegex.exec(html)) !== null) {
    const resolved = normalizeUrl(m[1], pageUrl);
    if (resolved) urls.push(resolved);
  }

  const embedRegex = /<embed\s[^>]*src=["']([^"']+)["']/gi;
  while ((m = embedRegex.exec(html)) !== null) {
    const resolved = normalizeUrl(m[1], pageUrl);
    if (resolved) urls.push(resolved);
  }

  const objectRegex = /<object\s[^>]*data=["']([^"']+)["']/gi;
  while ((m = objectRegex.exec(html)) !== null) {
    const resolved = normalizeUrl(m[1], pageUrl);
    if (resolved) urls.push(resolved);
  }

  return urls;
}

function getKnownPathsForCms(cms: CmsType): string[] {
  const universal = [
    '/',
    '/government',
    '/boards',
    '/documents',
    '/meetings',
    '/agendas',
    '/minutes',
    '/archives',
    '/selectmen',
    '/selectboard',
    '/board-of-selectmen',
    '/planning-board',
    '/zoning-board',
    '/conservation',
    '/town-departments',
    '/town-offices',
    '/agendas-minutes',
    '/public-notices',
    '/committees',
    '/forms',
    '/downloads',
    '/reports',
    '/budgets',
    '/ordinances',
    '/town-clerk',
    '/finance',
    '/building',
    '/fire-department',
    '/police-department',
    '/library',
    '/recreation',
    '/public-works',
  ];

  const civicPlusPaths = [
    '/agendacenter',
    '/documentcenter',
    '/formcenter',
    '/agendacenter/search',
    '/documentcenter/index',
    '/documentcenter/search',
  ];

  const wordPressPaths = [
    '/category/minutes',
    '/category/agendas',
    '/category/documents',
    '/wp-sitemap.xml',
  ];

  const revizePaths = [
    '/departments',
    '/government/boards-commissions',
    '/government/departments',
  ];

  switch (cms) {
    case 'CivicPlus':
      return [...universal, ...civicPlusPaths];
    case 'WordPress':
      return [...universal, ...wordPressPaths];
    case 'Revize':
      return [...universal, ...revizePaths];
    default:
      return [...universal, ...civicPlusPaths, ...wordPressPaths];
  }
}

function getCivicPlusPaginationUrls(html: string, pageUrl: string): string[] {
  const urls: string[] = [];
  const pageRegex = /page=(\d+)/gi;
  let maxPage = 1;
  let match;
  while ((match = pageRegex.exec(html)) !== null) {
    const p = parseInt(match[1]);
    if (p > maxPage) maxPage = p;
  }
  if (maxPage > 1) {
    const basePageUrl = pageUrl.replace(/[?&]page=\d+/, '');
    const separator = basePageUrl.includes('?') ? '&' : '?';
    for (let i = 2; i <= Math.min(maxPage, 50); i++) {
      urls.push(`${basePageUrl}${separator}page=${i}`);
    }
  }
  return urls;
}

function getCivicPlusDeepPaths(baseUrl: string): string[] {
  const paths: string[] = [];
  for (let i = 1; i <= 30; i++) {
    paths.push(`${baseUrl}/documentcenter/index/${i}`);
  }
  for (let i = 1; i <= 20; i++) {
    paths.push(`${baseUrl}/agendacenter/index/${i}`);
  }
  paths.push(`${baseUrl}/documentcenter/index/0`);
  paths.push(`${baseUrl}/agendacenter/index/0`);
  return paths;
}

async function probeWordPressMediaApi(baseUrl: string, signal: AbortSignal): Promise<string[]> {
  const docs: string[] = [];
  const perPage = 100;
  for (let page = 1; page <= 10; page++) {
    if (signal.aborted) break;
    try {
      const apiUrl = `${baseUrl}/wp-json/wp/v2/media?per_page=${perPage}&page=${page}&media_type=application`;
      const response = await fetch(apiUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) break;
      const items = await response.json() as Array<{ source_url?: string; mime_type?: string }>;
      if (!Array.isArray(items) || items.length === 0) break;
      for (const item of items) {
        if (item.source_url) {
          docs.push(item.source_url);
        }
      }
      if (items.length < perPage) break;
    } catch {
      break;
    }
  }
  return docs;
}

interface FetchPageResult {
  html: string;
  status: number;
  headers: Record<string, string>;
  finalUrl?: string;
}

async function fetchPageOnce(
  url: string, 
  signal: AbortSignal, 
  timeout = 15000,
  options?: { ua?: string; referer?: string }
): Promise<FetchPageResult | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    if (signal.aborted) throw new Error('Aborted');
    signal.addEventListener('abort', () => controller.abort(), { once: true });

    const ua = options?.ua || getRandomUA();
    const headers = getBrowserHeaders(ua, options?.referer);

    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);

    const respHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });
    const finalUrl = response.url || url;

    if (!response.ok) return { html: '', status: response.status, headers: respHeaders, finalUrl };
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return { html: '', status: response.status, headers: respHeaders, finalUrl };
    }
    const html = await response.text();
    
    const protection = detectProtection(html);
    if (protection) {
      markDomainProtected(url, protection);
      if (html.length < 5000) {
        return { html, status: response.status, headers: respHeaders, finalUrl };
      }
    }

    return { html, status: response.status, headers: respHeaders, finalUrl };
  } catch {
    return null;
  }
}

async function fetchPage(
  url: string, 
  signal: AbortSignal, 
  timeout = 15000,
  referer?: string
): Promise<FetchPageResult | null> {
  const MAX_RETRIES = 3;
  const domainDelay = getDomainDelay(url);
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) return null;
    
    const ua = getRandomUA();
    const result = await fetchPageOnce(url, signal, timeout, { ua, referer });
    
    if (result && result.status === 200 && result.html.length > 0) return result;
    
    if (result && result.status === 403) {
      if (attempt < MAX_RETRIES) {
        const backoff = (1000 * attempt) + domainDelay + Math.random() * 2000;
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
    }
    
    if (result && result.status >= 400 && result.status < 500 && result.status !== 429 && result.status !== 403) {
      return result;
    }
    
    if (attempt < MAX_RETRIES) {
      const backoff = (1000 * attempt) + domainDelay;
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  return await fetchPageOnce(url, signal, timeout, { ua: getRandomUA(), referer });
}

async function fetchPageViaBrowser(url: string): Promise<(FetchPageResult & { challengeResolved?: boolean }) | null> {
  const result = await browserFetchPage(url);
  if (!result) return null;

  if (result.wasChallenged && !result.challengeResolved) {
    return { html: '', status: 403, headers: {}, finalUrl: result.finalUrl, challengeResolved: false };
  }

  const protection = detectProtection(result.html);
  if (protection && result.html.length < 5000) {
    return { html: '', status: 403, headers: {}, finalUrl: result.finalUrl, challengeResolved: false };
  }

  return {
    html: result.html,
    status: result.status,
    headers: {},
    finalUrl: result.finalUrl,
    challengeResolved: result.wasChallenged ? result.challengeResolved : undefined,
  };
}

async function fetchHomepage(baseUrl: string, signal: AbortSignal): Promise<FetchPageResult & { useBrowser?: boolean; cloudflareManaged?: boolean } | null> {
  let result = await fetchPage(baseUrl, signal);
  if (result && result.status === 200 && result.html.length > 100) return result;

  const urlObj = new URL(baseUrl);
  const altUrl = urlObj.hostname.startsWith('www.')
    ? baseUrl.replace('://www.', '://')
    : baseUrl.replace('://', '://www.');
  const altResult = await fetchPage(altUrl, signal);
  if (altResult && altResult.status === 200 && altResult.html.length > 100) return altResult;

  const isBlocked = (!result || result.status === 403 || !result.html || result.html.length < 100);
  if (isBlocked) {
    const browserAvail = await isBrowserAvailable();
    if (browserAvail) {
      const browserResult = await fetchPageViaBrowser(baseUrl);
      if (browserResult && browserResult.html.length > 100) {
        return { ...browserResult, useBrowser: true };
      }
      if (browserResult && browserResult.challengeResolved === false) {
        return { html: '', status: 403, headers: {}, finalUrl: baseUrl, useBrowser: false, cloudflareManaged: true };
      }
      if (!browserResult || browserResult.html.length < 100) {
        const altBrowserResult = await fetchPageViaBrowser(altUrl);
        if (altBrowserResult && altBrowserResult.html.length > 100) {
          return { ...altBrowserResult, useBrowser: true };
        }
        if (altBrowserResult && altBrowserResult.challengeResolved === false) {
          return { html: '', status: 403, headers: {}, finalUrl: baseUrl, useBrowser: false, cloudflareManaged: true };
        }
      }
    }
  }

  return result;
}

async function fetchDocument(
  url: string, 
  signal: AbortSignal,
  referer?: string
): Promise<{ buffer: Buffer; contentType: string; size: number } | null> {
  const MAX_DOC_RETRIES = 2;
  const domainDelay = getDomainDelay(url);
  
  for (let attempt = 1; attempt <= MAX_DOC_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      signal.addEventListener('abort', () => controller.abort(), { once: true });

      const ua = getRandomUA();
      const refUrl = referer || new URL(url).origin;
      const headers = getDocDownloadHeaders(ua, refUrl);

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeoutId);

      if (response.status === 403 || response.status === 429) {
        if (attempt < MAX_DOC_RETRIES) {
          const backoff = 2000 * attempt + domainDelay + Math.random() * 2000;
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length < 100) {
        throw new Error('Document too small or empty');
      }
      const contentType = response.headers.get('content-type') || 'application/pdf';
      return { buffer, contentType, size: buffer.length };
    } catch (e: any) {
      if (attempt >= MAX_DOC_RETRIES) throw e;
      const backoff = 2000 * attempt + domainDelay;
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw new Error('Document download failed after retries');
}

function addLog(progress: CrawlProgress, message: string) {
  const timestamp = new Date().toISOString().substring(11, 19);
  progress.log.push(`[${timestamp}] ${message}`);
  if (progress.log.length > 2000) {
    progress.log = progress.log.slice(-1500);
  }
}

async function updateRunProgress(runId: string, progress: CrawlProgress) {
  await db.update(crawlerRuns)
    .set({
      pagesVisited: progress.pagesVisited,
      documentsDiscovered: progress.documentsDiscovered,
      documentsUploaded: progress.documentsDownloaded,
      documentsFailed: progress.documentsFailed,
    })
    .where(eq(crawlerRuns.id, runId));
}

async function parseSitemapRecursive(
  url: string,
  signal: AbortSignal,
  visited = new Set<string>(),
  currentDepth = 0,
  maxDepth = 3,
): Promise<string[]> {
  if (currentDepth >= maxDepth || visited.has(url) || signal.aborted) return [];
  visited.add(url);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];

    const xml = await response.text();

    if (xml.includes('<sitemapindex')) {
      const sitemapLocs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map(m => m[1].trim());
      const allUrls: string[] = [];
      for (const subUrl of sitemapLocs) {
        if (signal.aborted) break;
        const subUrls = await parseSitemapRecursive(subUrl, signal, visited, currentDepth + 1, maxDepth);
        allUrls.push(...subUrls);
      }
      return allUrls;
    }

    return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g))
      .map(m => m[1].trim())
      .filter(u => !u.endsWith('.xml'));
  } catch {
    return [];
  }
}

export async function startCrawl(
  town: CrawlerTown,
  run: CrawlerRun,
  options: { maxPages?: number; mode?: string } = {}
): Promise<string> {
  const runId = run.id;
  if (activeCrawls.has(runId)) {
    throw new Error('Crawl already running for this run ID');
  }

  const abortController = new AbortController();
  const progress: CrawlProgress = {
    runId,
    townId: town.id,
    townName: town.name,
    status: 'running',
    pagesVisited: 0,
    pagesQueued: 0,
    documentsDiscovered: 0,
    documentsDownloaded: 0,
    documentsFailed: 0,
    duplicatesSkipped: 0,
    currentUrl: '',
    log: [],
    startedAt: new Date(),
    strategyStats: { sitemap: 0, knownPaths: 0, breadthFirst: 0, external: 0, iframe: 0 },
  };

  const job: CrawlJob = { progress, abortController };
  activeCrawls.set(runId, job);

  executeCrawl(town, run, job, options).catch(err => {
    progress.status = 'failed';
    progress.errorMessage = err.message;
    addLog(progress, `FATAL: ${err.message}`);
    setTimeout(() => activeCrawls.delete(runId), 300000);
  });

  return runId;
}

async function executeCrawl(
  town: CrawlerTown,
  run: CrawlerRun,
  job: CrawlJob,
  options: { maxPages?: number; mode?: string }
) {
  const { progress, abortController } = job;
  const signal = abortController.signal;
  const maxPages = options.maxPages || town.maxPages || 500;
  const baseUrl = town.url.replace(/\/$/, '');
  const baseHostname = new URL(baseUrl).hostname;

  const s3 = new S3Client({ region: S3_REGION });

  addLog(progress, `Starting crawl of ${town.name} (${baseUrl})`);
  addLog(progress, `Max pages: ${maxPages}, Mode: ${options.mode || 'full'}`);

  const visited = new Set<string>();
  const docsSeen = new Map<string, { foundOnPage: string; strategy: keyof StrategyStats }>();
  const externalDocs: FoundDocument[] = [];
  const queue: Array<{ url: string; depth: number; priority: number }> = [];

  const stats = progress.strategyStats!;
  const summary: CrawlRunSummary = {
    byCategory: {},
    byBoard: {},
    newDocuments: 0,
    duplicates: 0,
    errors: [],
    failuresByType: {} as Record<FailureType, number>,
    pagesVisited: 0,
    documentsDiscovered: 0,
    protectionStats: {
      detected: false,
      types: [],
      blockedPages: 0,
      blockedDocuments: 0,
    },
  };

  let detectedCms: CmsType = (town.cms as CmsType) || null;
  let useBrowserMode = false;

  addLog(progress, '--- Phase 1: Homepage & CMS Detection ---');
  const homepage = await fetchHomepage(baseUrl, signal);
  if (!homepage || !homepage.html) {
    if ((homepage as any)?.cloudflareManaged) {
      addLog(progress, `BLOCKED: ${town.name} uses Cloudflare managed challenge (Turnstile) which cannot be bypassed by automated crawling. This site requires manual document collection.`);
      progress.protectionDetected = 'Cloudflare Managed';
      if (summary.protectionStats) {
        summary.protectionStats.detected = true;
        summary.protectionStats.types.push('Cloudflare Managed Challenge');
      }
    } else {
      addLog(progress, `WARNING: Homepage fetch failed for ${baseUrl} (status: ${homepage?.status || 'timeout'}). Site may be blocking requests or down.`);
    }
  }
  if (homepage && homepage.html) {
    if ((homepage as any).useBrowser) {
      useBrowserMode = true;
      addLog(progress, `BROWSER MODE: Cloudflare challenge solved via headless browser. Switching to browser-based crawling.`);
    }
    if (homepage.finalUrl && homepage.finalUrl !== baseUrl && homepage.finalUrl !== baseUrl + '/') {
      addLog(progress, `Homepage redirected to: ${homepage.finalUrl}`);
    }
    const protection = detectProtection(homepage.html);
    if (protection) {
      progress.protectionDetected = protection;
      markDomainProtected(baseUrl, protection);
      if (summary.protectionStats) {
        summary.protectionStats.detected = true;
        if (!summary.protectionStats.types.includes(protection)) {
          summary.protectionStats.types.push(protection);
        }
      }
      if (!useBrowserMode) {
        addLog(progress, `WARNING: ${protection} protection detected. Using rotating UAs and adaptive delays.`);
      }

      await db.update(crawlerTowns)
        .set({ updatedAt: new Date() })
        .where(eq(crawlerTowns.id, town.id));
    }

    if (!detectedCms) {
      detectedCms = detectCmsFromHtml(homepage.html, baseUrl);
      progress.detectedCms = detectedCms || undefined;
      addLog(progress, `CMS detected: ${detectedCms}`);

      if (detectedCms && detectedCms !== 'Custom') {
        await db.update(crawlerTowns)
          .set({ cms: detectedCms })
          .where(eq(crawlerTowns.id, town.id));
      }
    } else {
      progress.detectedCms = detectedCms;
      addLog(progress, `CMS (from profile): ${detectedCms}`);
    }

    visited.add(baseUrl);
    visited.add(baseUrl + '/');
    progress.pagesVisited++;

    const homeLinks = extractLinksFromHtml(homepage.html, baseUrl);
    let homeDocsFound = 0;
    for (const link of homeLinks) {
      if (isDocumentUrl(link.href) && !docsSeen.has(link.href)) {
        docsSeen.set(link.href, { foundOnPage: baseUrl, strategy: 'breadthFirst' });
        stats.breadthFirst++;
        progress.documentsDiscovered++;
        homeDocsFound++;
      } else if (isExternalDocumentLink(link.href) && !docsSeen.has(link.href)) {
        docsSeen.set(link.href, { foundOnPage: baseUrl, strategy: 'external' });
        externalDocs.push({ url: link.href, linkText: link.text, foundOnPage: baseUrl, strategy: 'external' });
        stats.external++;
        progress.documentsDiscovered++;
        homeDocsFound++;
      } else if (isNavigationLink(link.href, baseHostname) && !visited.has(link.href)) {
        const prio = isHighPriorityUrl(link.href) ? 1 : 3;
        queue.push({ url: link.href, depth: 1, priority: prio });
      }
    }

    const embeds = extractIframeAndEmbedSrcs(homepage.html, baseUrl);
    for (const embedUrl of embeds) {
      if (isDocumentUrl(embedUrl) && !docsSeen.has(embedUrl)) {
        docsSeen.set(embedUrl, { foundOnPage: baseUrl, strategy: 'iframe' });
        stats.iframe++;
        progress.documentsDiscovered++;
        homeDocsFound++;
      }
    }
    addLog(progress, `Homepage: ${homeLinks.length} links, ${homeDocsFound} docs, ${queue.length} nav pages queued`);

    if (detectedCms === 'CivicPlus') {
      const paginationUrls = getCivicPlusPaginationUrls(homepage.html, baseUrl);
      for (const pu of paginationUrls) {
        if (!visited.has(pu)) queue.push({ url: pu, depth: 1, priority: 1 });
      }
    }
  }

  addLog(progress, '--- Phase 2: Sitemap Discovery ---');
  const sitemapUrls = [
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
    `${baseUrl}/sitemap.php`,
  ];
  if (detectedCms === 'WordPress') {
    sitemapUrls.push(`${baseUrl}/wp-sitemap.xml`);
  }

  let sitemapDocCount = 0;
  let sitemapNavCount = 0;
  const sitemapUrlsSeen = new Set<string>();
  for (const smUrl of sitemapUrls) {
    if (signal.aborted) break;
    const urls = await parseSitemapRecursive(smUrl, signal);
    if (urls.length > 0) {
      addLog(progress, `Sitemap ${smUrl}: ${urls.length} URLs found`);
      for (const u of urls) {
        if (sitemapUrlsSeen.has(u)) continue;
        sitemapUrlsSeen.add(u);
        if (isDocumentUrl(u) && !docsSeen.has(u)) {
          docsSeen.set(u, { foundOnPage: smUrl, strategy: 'sitemap' });
          stats.sitemap++;
          sitemapDocCount++;
          progress.documentsDiscovered++;
        } else if (isSameDomain(u, baseUrl) && !visited.has(u)) {
          const prio = isHighPriorityUrl(u) ? 1 : 3;
          queue.push({ url: u, depth: 1, priority: prio });
          sitemapNavCount++;
        }
      }
    }
  }
  addLog(progress, `Sitemap results: ${sitemapDocCount} docs, ${sitemapNavCount} pages queued`);

  addLog(progress, '--- Phase 3: Known Path Probing ---');
  const phaseStart3 = Date.now();
  const knownPaths = getKnownPathsForCms(detectedCms);
  const customPaths = town.customPaths || [];
  const allPaths = Array.from(new Set([...knownPaths, ...customPaths]));
  let validPaths = 0;
  let knownPathDocsFound = 0;

  for (const p of allPaths) {
    if (signal.aborted) break;
    const fullUrl = p.startsWith('http') ? p : `${baseUrl}${p}`;
    if (visited.has(fullUrl)) continue;

    const resp = useBrowserMode 
      ? await fetchPageViaBrowser(fullUrl)
      : await fetchPage(fullUrl, signal, 8000);
    if (resp && resp.status === 200 && resp.html.length > 500) {
      validPaths++;
      visited.add(fullUrl);
      progress.pagesVisited++;

      const links = extractLinksFromHtml(resp.html, fullUrl);
      let pathDocsCount = 0;
      for (const link of links) {
        if (isDocumentUrl(link.href) && !docsSeen.has(link.href)) {
          docsSeen.set(link.href, { foundOnPage: fullUrl, strategy: 'knownPaths' });
          stats.knownPaths++;
          progress.documentsDiscovered++;
          pathDocsCount++;
          knownPathDocsFound++;
        } else if (isExternalDocumentLink(link.href) && !docsSeen.has(link.href)) {
          docsSeen.set(link.href, { foundOnPage: fullUrl, strategy: 'external' });
          externalDocs.push({ url: link.href, linkText: link.text, foundOnPage: fullUrl, strategy: 'external' });
          stats.external++;
          progress.documentsDiscovered++;
          pathDocsCount++;
        } else if (isNavigationLink(link.href, baseHostname) && !visited.has(link.href)) {
          const prio = isHighPriorityUrl(link.href) ? 1 : 3;
          queue.push({ url: link.href, depth: 1, priority: prio });
        }
      }

      const embeds = extractIframeAndEmbedSrcs(resp.html, fullUrl);
      for (const embedUrl of embeds) {
        if (isDocumentUrl(embedUrl) && !docsSeen.has(embedUrl)) {
          docsSeen.set(embedUrl, { foundOnPage: fullUrl, strategy: 'iframe' });
          stats.iframe++;
          progress.documentsDiscovered++;
          pathDocsCount++;
        }
      }

      if (detectedCms === 'CivicPlus') {
        const paginationUrls = getCivicPlusPaginationUrls(resp.html, fullUrl);
        for (const pu of paginationUrls) {
          if (!visited.has(pu)) queue.push({ url: pu, depth: 1, priority: 1 });
        }
      }

      if (pathDocsCount > 0) {
        addLog(progress, `KnownPath ${p}: ${pathDocsCount} docs found`);
      }
    }

    await new Promise(r => setTimeout(r, 150));
  }
  addLog(progress, `Known paths: ${validPaths} valid out of ${allPaths.length} probed, ${knownPathDocsFound} docs found (${Math.round((Date.now() - phaseStart3) / 1000)}s)`);

  if (detectedCms === 'CivicPlus' && !signal.aborted) {
    addLog(progress, '--- Phase 3b: CivicPlus Deep Crawl ---');
    const deepPaths = getCivicPlusDeepPaths(baseUrl);
    let deepDocsFound = 0;
    let deepValidPaths = 0;
    for (const dp of deepPaths) {
      if (signal.aborted) break;
      if (visited.has(dp)) continue;
      const resp = useBrowserMode
        ? await fetchPageViaBrowser(dp)
        : await fetchPage(dp, signal, 8000);
      if (resp && resp.status === 200 && resp.html.length > 500) {
        deepValidPaths++;
        visited.add(dp);
        progress.pagesVisited++;
        const links = extractLinksFromHtml(resp.html, dp);
        for (const link of links) {
          if (isDocumentUrl(link.href) && !docsSeen.has(link.href)) {
            docsSeen.set(link.href, { foundOnPage: dp, strategy: 'knownPaths' });
            stats.knownPaths++;
            progress.documentsDiscovered++;
            deepDocsFound++;
          }
        }
        const paginationUrls = getCivicPlusPaginationUrls(resp.html, dp);
        for (const pu of paginationUrls) {
          if (!visited.has(pu)) queue.push({ url: pu, depth: 1, priority: 1 });
        }
      }
      await new Promise(r => setTimeout(r, 150));
    }
    addLog(progress, `CivicPlus deep crawl: ${deepValidPaths} valid pages, ${deepDocsFound} docs found`);
  }

  if (detectedCms === 'WordPress' && !signal.aborted) {
    addLog(progress, '--- Phase 3b: WordPress Media API ---');
    const wpDocs = await probeWordPressMediaApi(baseUrl, signal);
    let wpNewDocs = 0;
    for (const wpUrl of wpDocs) {
      if (!docsSeen.has(wpUrl) && isDocumentUrl(wpUrl)) {
        docsSeen.set(wpUrl, { foundOnPage: `${baseUrl}/wp-json/wp/v2/media`, strategy: 'sitemap' });
        stats.sitemap++;
        progress.documentsDiscovered++;
        wpNewDocs++;
      }
    }
    addLog(progress, `WordPress Media API: ${wpDocs.length} media items found, ${wpNewDocs} new docs`);
  }

  addLog(progress, `--- Phase 4: Breadth-First Crawl ${useBrowserMode ? '(BROWSER MODE)' : ''} ---`);
  progress.pagesQueued = queue.length;
  let progressUpdateCounter = 0;
  let consecutiveEmptyPages = 0;
  const MAX_CONSECUTIVE_EMPTY = Math.max(40, Math.min(queue.length, 80));

  while (queue.length > 0 && progress.pagesVisited < maxPages) {
    if (signal.aborted) {
      addLog(progress, 'Crawl aborted by user');
      break;
    }

    if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY) {
      addLog(progress, `Stopping: ${MAX_CONSECUTIVE_EMPTY} consecutive pages with no new documents`);
      break;
    }

    queue.sort((a, b) => a.priority - b.priority || a.depth - b.depth);
    const { url: pageUrl, depth } = queue.shift()!;

    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    if (!isSameDomain(pageUrl, baseUrl)) continue;

    progress.currentUrl = pageUrl;
    progress.pagesQueued = queue.length;

    let page: FetchPageResult | null = null;
    if (useBrowserMode) {
      page = await fetchPageViaBrowser(pageUrl);
      if (useBrowserMode) await new Promise(r => setTimeout(r, 500));
    } else {
      page = await fetchPage(pageUrl, signal, 15000, baseUrl);
    }
    if (!page || !page.html) {
      if (!useBrowserMode && page && page.status === 403) {
        const browserPage = await fetchPageViaBrowser(pageUrl);
        if (browserPage && browserPage.html.length > 100) {
          page = browserPage;
          if (!useBrowserMode) {
            useBrowserMode = true;
            addLog(progress, `BROWSER MODE: Switching to browser-based crawling after 403 on ${pageUrl.substring(baseUrl.length)}`);
          }
        }
      }
      if (!page || !page.html) continue;
    }

    if (page.html && detectProtection(page.html)) {
      const protType = detectProtection(page.html)!;
      markDomainProtected(pageUrl, protType);
      if (summary.protectionStats) {
        summary.protectionStats.detected = true;
        summary.protectionStats.blockedPages++;
        if (!summary.protectionStats.types.includes(protType)) {
          summary.protectionStats.types.push(protType);
        }
      }
      addLog(progress, `PROTECTION: ${protType} on ${pageUrl.substring(baseUrl.length)} (adaptive delay enabled)`);
      continue;
    }

    progress.pagesVisited++;
    summary.pagesVisited = progress.pagesVisited;

    const links = extractLinksFromHtml(page.html, pageUrl);
    let pageDocsFound = 0;

    for (const link of links) {
      if (isDocumentUrl(link.href) && !docsSeen.has(link.href)) {
        docsSeen.set(link.href, { foundOnPage: pageUrl, strategy: 'breadthFirst' });
        pageDocsFound++;
        stats.breadthFirst++;
        progress.documentsDiscovered++;
        summary.documentsDiscovered = progress.documentsDiscovered;
      } else if (isExternalDocumentLink(link.href) && !docsSeen.has(link.href)) {
        docsSeen.set(link.href, { foundOnPage: pageUrl, strategy: 'external' });
        externalDocs.push({ url: link.href, linkText: link.text, foundOnPage: pageUrl, strategy: 'external' });
        stats.external++;
        pageDocsFound++;
        progress.documentsDiscovered++;
        summary.documentsDiscovered = progress.documentsDiscovered;
      }

      if (depth < 5 && !visited.has(link.href) && isNavigationLink(link.href, baseHostname)) {
        const prio = isHighPriorityUrl(link.href) ? Math.min(depth + 1, 5) : depth + 3;
        queue.push({ url: link.href, depth: depth + 1, priority: prio });
      }
    }

    const embeds = extractIframeAndEmbedSrcs(page.html, pageUrl);
    for (const embedUrl of embeds) {
      if (isDocumentUrl(embedUrl) && !docsSeen.has(embedUrl)) {
        docsSeen.set(embedUrl, { foundOnPage: pageUrl, strategy: 'iframe' });
        stats.iframe++;
        pageDocsFound++;
        progress.documentsDiscovered++;
      }
    }

    if (detectedCms === 'CivicPlus') {
      const paginationUrls = getCivicPlusPaginationUrls(page.html, pageUrl);
      for (const pu of paginationUrls) {
        if (!visited.has(pu)) queue.push({ url: pu, depth, priority: 1 });
      }
    }

    if (pageDocsFound > 0) {
      consecutiveEmptyPages = 0;
      addLog(progress, `Page ${progress.pagesVisited}: ${pageDocsFound} docs on ${pageUrl.substring(baseUrl.length) || '/'}`);
    } else {
      consecutiveEmptyPages++;
    }

    progressUpdateCounter++;
    if (progressUpdateCounter % 5 === 0) {
      await updateRunProgress(run.id, progress);
    }

    const delay = 200 + Math.random() * 500;
    await new Promise(r => setTimeout(r, delay));
  }

  addLog(progress, `--- Phase 5: Download ${docsSeen.size} documents ---`);
  addLog(progress, `Strategy breakdown: Sitemap=${stats.sitemap}, KnownPaths=${stats.knownPaths}, BFS=${stats.breadthFirst}, External=${stats.external}, Iframe=${stats.iframe}`);

  const docsToDownload = Array.from(docsSeen.entries());
  let downloadIndex = 0;
  for (const [docUrl, docInfo] of docsToDownload) {
    if (signal.aborted) break;
    downloadIndex++;

    if (isExternalDocumentLink(docUrl)) {
      await recordDocument({
        townId: town.id,
        url: docUrl,
        urlHash: hashUrl(docUrl),
        filename: extractFilename(docUrl),
        status: 'discovered',
        discoveredFrom: docInfo.foundOnPage,
      });
      addLog(progress, `EXTERNAL (recorded): ${docUrl.substring(0, 80)}`);
      continue;
    }

    const urlHash = hashUrl(docUrl);
    const filename = extractFilename(docUrl);
    const metadata = extractDocumentMetadata(docUrl, filename, baseUrl);
    const s3Key = generateS3Key({
      town: town.slug,
      url: docUrl,
      filename,
      discoveredFrom: docInfo.foundOnPage,
    });

    summary.byCategory[metadata.category] = (summary.byCategory[metadata.category] || 0) + 1;
    if (metadata.board) {
      summary.byBoard[metadata.board] = (summary.byBoard[metadata.board] || 0) + 1;
    }

    const existing = await db.select({ id: crawlerDocuments.id, status: crawlerDocuments.status })
      .from(crawlerDocuments)
      .where(eq(crawlerDocuments.urlHash, urlHash))
      .limit(1);

    if (existing.length > 0 && existing[0].status === 'uploaded') {
      progress.duplicatesSkipped++;
      summary.duplicates++;
      continue;
    }

    try {
      if (await s3KeyExists(s3, s3Key)) {
        await recordDocument({
          townId: town.id,
          url: docUrl,
          urlHash,
          filename,
          category: metadata.category,
          board: metadata.board,
          year: metadata.year,
          s3Key,
          status: 'uploaded',
          discoveredFrom: docInfo.foundOnPage,
          s3UploadedAt: new Date(),
        });
        progress.duplicatesSkipped++;
        summary.duplicates++;
        continue;
      }

      let doc = await fetchDocument(docUrl, signal, docInfo.foundOnPage).catch(async (e: any) => {
        if (useBrowserMode && (e.message?.includes('403') || e.message?.includes('429') || e.message?.includes('Challenge'))) {
          addLog(progress, `Browser fallback for doc: ${filename}`);
          return await browserFetchDocument(docUrl, docInfo.foundOnPage);
        }
        throw e;
      });
      if (doc) {
        await uploadToS3(s3, s3Key, doc.buffer, doc.contentType);
        await recordDocument({
          townId: town.id,
          url: docUrl,
          urlHash,
          filename,
          category: metadata.category,
          board: metadata.board,
          year: metadata.year,
          s3Key,
          sizeBytes: doc.size,
          mimeType: doc.contentType,
          status: 'uploaded',
          discoveredFrom: docInfo.foundOnPage,
          s3UploadedAt: new Date(),
        });
        progress.documentsDownloaded++;
        summary.newDocuments++;
        if (downloadIndex % 10 === 0 || progress.documentsDownloaded <= 5) {
          addLog(progress, `OK [${downloadIndex}/${docsSeen.size}]: ${filename} (${Math.round(doc.size / 1024)}KB)`);
        }
      }
    } catch (e: any) {
      const failureType = classifyError(e);
      progress.documentsFailed++;
      summary.errors.push({
        url: docUrl,
        error: e.message || 'Unknown error',
        failureType,
      });
      if (summary.failuresByType) {
        summary.failuresByType[failureType] = (summary.failuresByType[failureType] || 0) + 1;
      }
      if (e.message?.includes('403') && summary.protectionStats) {
        summary.protectionStats.blockedDocuments++;
        summary.protectionStats.detected = true;
      }

      await recordDocument({
        townId: town.id,
        url: docUrl,
        urlHash,
        filename,
        category: metadata.category,
        board: metadata.board,
        year: metadata.year,
        status: 'failed',
        errorMessage: e.message,
        discoveredFrom: docInfo.foundOnPage,
      });

      if (downloadIndex % 10 === 0) {
        addLog(progress, `FAIL [${downloadIndex}/${docsSeen.size}]: ${filename} - ${e.message}`);
      }
    }

    if (downloadIndex % 5 === 0) {
      await updateRunProgress(run.id, progress);
    }

    const delay = 200 + Math.random() * 500;
    await new Promise(r => setTimeout(r, delay));
  }

  progress.status = 'completed';
  progress.completedAt = new Date();
  progress.currentUrl = '';

  const finalStats = `Pages: ${progress.pagesVisited}, Docs found: ${progress.documentsDiscovered}, Downloaded: ${progress.documentsDownloaded}, Failed: ${progress.documentsFailed}, Duplicates: ${progress.duplicatesSkipped}`;
  addLog(progress, `Crawl complete. ${finalStats}`);
  addLog(progress, `Strategy: Sitemap=${stats.sitemap}, KnownPaths=${stats.knownPaths}, BFS=${stats.breadthFirst}, External=${stats.external}, Iframe=${stats.iframe}`);

  const finalStatus = progress.documentsFailed > 0 && progress.documentsDownloaded === 0 ? 'failed' : 'completed';

  if (useBrowserMode) {
    addLog(progress, `Browser mode was used for this crawl (Cloudflare/protection bypass)`);
  }

  (summary as any).strategyStats = stats;
  (summary as any).detectedCms = detectedCms;
  (summary as any).protectionDetected = progress.protectionDetected;
  (summary as any).usedBrowserMode = useBrowserMode;

  await db.update(crawlerRuns)
    .set({
      status: finalStatus,
      completedAt: new Date(),
      pagesVisited: progress.pagesVisited,
      documentsDiscovered: progress.documentsDiscovered,
      documentsUploaded: progress.documentsDownloaded,
      documentsFailed: progress.documentsFailed,
      summary,
      logs: progress.log || [],
    })
    .where(eq(crawlerRuns.id, run.id));

  await db.update(crawlerTowns)
    .set({
      lastFullCrawl: new Date(),
      totalDocuments: sql`(SELECT COUNT(*) FROM crawler_documents WHERE town_id = ${town.id})`,
      totalUploaded: sql`(SELECT COUNT(*) FROM crawler_documents WHERE town_id = ${town.id} AND status = 'uploaded')`,
      lastCrawlDocsFound: progress.documentsDiscovered,
      consecutiveFailures: finalStatus === 'failed' ? sql`consecutive_failures + 1` : 0,
      updatedAt: new Date(),
    })
    .where(eq(crawlerTowns.id, town.id));

  if (useBrowserMode) {
    closeBrowser().catch(() => {});
  }

  setTimeout(() => {
    activeCrawls.delete(run.id);
  }, 300000);
}

export function getCrawlProgress(runId: string): CrawlProgress | null {
  const job = activeCrawls.get(runId);
  return job?.progress || null;
}

export function getActiveCrawls(): CrawlProgress[] {
  return Array.from(activeCrawls.values()).map(j => j.progress);
}

export function abortCrawl(runId: string): boolean {
  const job = activeCrawls.get(runId);
  if (!job) return false;
  job.abortController.abort();
  job.progress.status = 'failed';
  job.progress.errorMessage = 'Aborted by admin';
  addLog(job.progress, 'Crawl aborted by admin');
  setTimeout(() => activeCrawls.delete(runId), 300000);
  return true;
}
