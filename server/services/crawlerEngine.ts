import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';
import { db } from '../storage/db';
import * as schema from '../../shared/schema';
import { crawlerDocuments, crawlerTowns, crawlerRuns, crawlerStateSources, crawlerStateSourceRuns, crawlerStateDocuments } from '../../shared/crawler-schema';
import type { CrawlerTown, CrawlerRun, CrawlRunSummary, FailureType, CrawlerStateSource, CrawlerStateSourceRun, InsertCrawlerStateDocument } from '../../shared/crawler-schema';
import { classifyError } from '../../shared/crawler-schema';
import { eq, sql } from 'drizzle-orm';
import {
  generateS3Key,
  extractFilename,
  extractDocumentMetadata,
} from './crawlerStateExtensions';
import { hashUrl, recordDocument, batchRecordDocuments, getAllTownDocumentUrls, getResumableDocuments, recordStateDocument, batchRecordStateDocuments, getAllStateDocumentUrls, getResumableStateDocuments, updateStateRunProgress } from './crawlerState';
import type { InsertCrawlerDocument } from '../../shared/crawler-schema';
import { isScrapingApiConfigured, fetchPageViaAPI, fetchDocumentViaAPI, fetchDocumentWithCookies, extractFinalUrlFromInterstitial, resolveRedirectViaAPI } from './scrapingApiClient';
import { isGoogleDriveConfigured, listFolderRecursive, downloadDriveFile } from './googleDriveClient';
import { completeStateSourceRun } from '../storage/crawler';

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

export const activeCrawls = new Map<string, CrawlJob>();

export interface CrawlProgress {
  runId: string;
  townId: string;
  townName: string;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
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
  googleDrive: number;
}

interface FoundDocument {
  url: string;
  linkText: string;
  foundOnPage: string;
  strategy: keyof StrategyStats;
}

export interface CrawlJob {
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
  if ((lower.includes('akamai') || lower.includes('edgesuite.net')) && (lower.includes('access denied') || lower.includes('bot manager'))) {
    return 'akamai';
  }
  if (lower.includes('<title>access denied</title>') && lower.includes('reference&#32;')) {
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

  if (/\/(minutes|agenda)\/(minutes|agenda)-\d+/i.test(lower)) return true;

  return false;
}

function isCivicPlusRedirectUrl(url: string): boolean {
  return /\/(minutes|agenda)\/(minutes|agenda)-\d+/i.test(url.toLowerCase());
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

async function bridgeToFileBlob(crawlerDocId: string, opts: {
  s3Key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<void> {
  try {
    const rawHash = `s3:${opts.s3Key}`;
    const existing = await db.execute(
      sql`SELECT id FROM file_blobs WHERE raw_hash = ${rawHash}`
    );
    let fileBlobId: string;
    if (existing.rows.length > 0) {
      fileBlobId = (existing.rows[0] as any).id;
    } else {
      const storagePath = `s3://${S3_BUCKET}/${opts.s3Key}`;
      const [blob] = await db
        .insert(schema.fileBlobs)
        .values({
          rawHash,
          sizeBytes: opts.sizeBytes || 0,
          mimeType: opts.mimeType || 'application/pdf',
          originalFilename: opts.filename || opts.s3Key.split('/').pop() || 'unknown.pdf',
          storagePath,
          s3Bucket: S3_BUCKET,
          s3Key: opts.s3Key,
          needsOcr: false,
          ocrStatus: 'none',
          extractedTextCharCount: 0,
          embeddingStatus: 'none',
        })
        .returning();
      fileBlobId = blob.id;
    }
    await db.execute(sql`
      UPDATE crawler_documents SET file_blob_id = ${fileBlobId} WHERE id = ${crawlerDocId} AND file_blob_id IS NULL
    `);
  } catch (e: any) {
    console.warn(`[CrawlerEngine] bridgeToFileBlob failed for ${opts.s3Key}: ${e.message}`);
  }
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
    '/minutes-and-agendas',
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


async function fetchHomepage(baseUrl: string, signal: AbortSignal): Promise<FetchPageResult & { needsHeavyLane?: boolean; viaHeavyLane?: boolean } | null> {
  let result = await fetchPage(baseUrl, signal);
  if (result && result.status === 200 && result.html.length > 100) return result;

  const urlObj = new URL(baseUrl);
  const altUrl = urlObj.hostname.startsWith('www.')
    ? baseUrl.replace('://www.', '://')
    : baseUrl.replace('://', '://www.');
  const altResult = await fetchPage(altUrl, signal);
  if (altResult && altResult.status === 200 && altResult.html.length > 100) return altResult;

  const isBlocked = (!result || result.status === 403 || result.status === 429 || !result.html || result.html.length < 100);
  if (isBlocked && isScrapingApiConfigured()) {
    const apiResult = await fetchPageViaAPI(baseUrl);
    if (apiResult && apiResult.html.length > 100 && apiResult.status === 200) {
      return { html: apiResult.html, status: apiResult.status, headers: apiResult.headers, finalUrl: apiResult.finalUrl, viaHeavyLane: true };
    }
    const altApiResult = await fetchPageViaAPI(altUrl);
    if (altApiResult && altApiResult.html.length > 100 && altApiResult.status === 200) {
      return { html: altApiResult.html, status: altApiResult.status, headers: altApiResult.headers, finalUrl: altApiResult.finalUrl, viaHeavyLane: true };
    }
  }

  if (isBlocked) {
    return { html: '', status: result?.status || 0, headers: {}, finalUrl: baseUrl, needsHeavyLane: true };
  }

  return result;
}

const DOC_EXTENSIONS = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|rtf|odt|ods)$/i;

interface FetchDocumentResult {
  buffer: Buffer;
  contentType: string;
  size: number;
  isInterstitial?: boolean;
  interstitialHtml?: string;
}

async function fetchDocument(
  url: string, 
  signal: AbortSignal,
  referer?: string
): Promise<FetchDocumentResult | null> {
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
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || 'application/pdf';
      const urlPath = new URL(url).pathname;
      if (DOC_EXTENSIONS.test(urlPath) && contentType.includes('text/html')) {
        const html = await response.text();
        return { buffer: Buffer.alloc(0), contentType, size: 0, isInterstitial: true, interstitialHtml: html };
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length < 100) {
        throw new Error('Document too small or empty');
      }
      return { buffer, contentType, size: buffer.length };
    } catch (e: any) {
      if (attempt >= MAX_DOC_RETRIES) throw e;
      const backoff = 2000 * attempt + domainDelay;
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw new Error('Document download failed after retries');
}

export function addLog(progress: CrawlProgress, message: string) {
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
      logs: progress.log || [],
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
    strategyStats: { sitemap: 0, knownPaths: 0, breadthFirst: 0, external: 0, iframe: 0, googleDrive: 0 },
  };

  const job: CrawlJob = { progress, abortController };
  activeCrawls.set(runId, job);

  executeCrawl(town, run, job, options).catch(async (err) => {
    progress.status = 'failed';
    progress.errorMessage = err.message;
    addLog(progress, `FATAL: Unhandled exception — ${err.message}`);
    addLog(progress, `FATAL: Stack — ${err.stack?.split('\n').slice(0, 3).join(' | ') || 'no stack'}`);

    try {
      await db.update(crawlerRuns)
        .set({
          status: 'failed',
          completedAt: new Date(),
          pagesVisited: progress.pagesVisited,
          documentsDiscovered: progress.documentsDiscovered,
          documentsUploaded: progress.documentsDownloaded,
          documentsFailed: progress.documentsFailed,
          errorMessage: `CRASH: ${err.message}`,
          logs: progress.log || [],
        })
        .where(eq(crawlerRuns.id, run.id));
    } catch (dbErr: any) {
      addLog(progress, `FATAL: Could not persist crash state to DB — ${dbErr.message}`);
    }

    setTimeout(() => activeCrawls.delete(runId), 300000);
  });

  return runId;
}

function buildBatchRecords(
  townId: string,
  docsSeen: Map<string, { foundOnPage: string; strategy: keyof StrategyStats; driveMimeType?: string; driveFolderPath?: string }>,
  alreadyPersisted: Set<string>,
  baseUrl: string,
): InsertCrawlerDocument[] {
  const records: InsertCrawlerDocument[] = [];
  for (const [url, info] of docsSeen) {
    if (alreadyPersisted.has(url)) continue;
    const urlH = hashUrl(url);
    const filename = extractFilename(url);
    const metadata = url.startsWith('gdrive://') ? {} : extractDocumentMetadata(url, filename, baseUrl);
    records.push({
      townId,
      url,
      urlHash: urlH,
      filename,
      discoveredFrom: info.foundOnPage,
      status: 'discovered',
      category: metadata.category || undefined,
      board: metadata.board || undefined,
      year: metadata.year || undefined,
    });
    alreadyPersisted.add(url);
  }
  return records;
}

async function executeCrawl(
  town: CrawlerTown,
  run: CrawlerRun,
  job: CrawlJob,
  options: { maxPages?: number; mode?: string }
) {
  const { progress, abortController } = job;
  const signal = abortController.signal;
  const maxPages = options.maxPages || town.maxPages || 1000;
  const baseUrl = town.url.replace(/\/$/, '');
  const baseHostname = new URL(baseUrl).hostname;

  const s3 = new S3Client({ region: S3_REGION });

  addLog(progress, `Starting crawl of ${town.name} (${baseUrl})`);
  addLog(progress, `Max pages: ${maxPages}, Mode: ${options.mode || 'full'}`);

  const visited = new Set<string>();
  const docsSeen = new Map<string, { foundOnPage: string; strategy: keyof StrategyStats; driveMimeType?: string; driveFolderPath?: string }>();
  const alreadyPersisted = new Set<string>();
  const externalDocs: FoundDocument[] = [];
  const queue: Array<{ url: string; depth: number; priority: number }> = [];

  addLog(progress, 'Pre-seeding from database...');
  const existingDocs = await getAllTownDocumentUrls(town.id);
  let preSeededUploaded = 0;
  let preSeededOther = 0;
  for (const doc of existingDocs) {
    docsSeen.set(doc.url, { foundOnPage: doc.discoveredFrom || 'db-preseed', strategy: 'breadthFirst' });
    alreadyPersisted.add(doc.url);
    if (doc.status === 'uploaded') preSeededUploaded++;
    else preSeededOther++;
  }
  addLog(progress, `Pre-seeded ${existingDocs.length} known URLs (${preSeededUploaded} uploaded, ${preSeededOther} discovered/failed)`);

  const isResumeMode = options.mode === 'resume';

  if (isResumeMode) {
    addLog(progress, '=== RESUME MODE: Skipping discovery, loading pending downloads from DB ===');
    docsSeen.clear();
    const resumableDocs = await getResumableDocuments(town.id);
    const discoveredCount = resumableDocs.filter(d => d.status === 'discovered').length;
    const failedCount = resumableDocs.filter(d => d.status === 'failed').length;
    addLog(progress, `RESUME MODE: Found ${resumableDocs.length} documents to retry (${discoveredCount} discovered, ${failedCount} failed)`);

    for (const doc of resumableDocs) {
      docsSeen.set(doc.url, {
        foundOnPage: doc.discoveredFrom || 'resume',
        strategy: doc.url.startsWith('gdrive://') ? 'googleDrive' : 'breadthFirst',
      });
    }
    progress.documentsDiscovered = resumableDocs.length;
  }

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
  const heavyLaneDomains = new Set<string>();
  let heavyLaneRequests = 0;
  let fastLaneRequests = 0;
  let interstitialsBypassed = 0;

  const flagHeavyLane = (url: string) => {
    try { heavyLaneDomains.add(new URL(url).hostname); } catch {}
  };
  const isHeavyLane = (url: string): boolean => {
    try { return heavyLaneDomains.has(new URL(url).hostname); } catch { return false; }
  };

  if (!isResumeMode) {
  addLog(progress, '--- Phase 1: Homepage & CMS Detection ---');
  fastLaneRequests++;
  const homepage = await fetchHomepage(baseUrl, signal);
  if (!homepage || !homepage.html) {
    if ((homepage as any)?.needsHeavyLane) {
      flagHeavyLane(baseUrl);
      if (isScrapingApiConfigured()) {
        addLog(progress, `HEAVY LANE: Homepage blocked (status: ${homepage?.status || 'timeout'}). Domain flagged for scraping API. API also failed to retrieve homepage.`);
      } else {
        addLog(progress, `HEAVY LANE: Homepage blocked (status: ${homepage?.status || 'timeout'}). Domain flagged for scraping API. Configure SCRAPING_API_KEY to enable Heavy Lane.`);
      }
      if (summary.protectionStats) {
        summary.protectionStats.detected = true;
        if (!summary.protectionStats.types.includes('Blocked')) {
          summary.protectionStats.types.push('Blocked');
        }
      }
    } else {
      addLog(progress, `WARNING: Homepage fetch failed for ${baseUrl} (status: ${homepage?.status || 'timeout'}). Site may be blocking requests or down.`);
    }
  }
  if (homepage && homepage.html) {
    if ((homepage as any)?.viaHeavyLane) {
      flagHeavyLane(baseUrl);
      heavyLaneRequests++;
      addLog(progress, `HEAVY LANE: Homepage retrieved via scraping API. Domain flagged for Heavy Lane.`);
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
      addLog(progress, `WARNING: ${protection} protection detected. Domain flagged for Heavy Lane.`);
      flagHeavyLane(baseUrl);

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

  {
    const batch = buildBatchRecords(town.id, docsSeen, alreadyPersisted, baseUrl);
    if (batch.length > 0) {
      await batchRecordDocuments(batch);
      addLog(progress, `Phase 1: Persisted ${batch.length} discovered URLs to database`);
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

  {
    const batch = buildBatchRecords(town.id, docsSeen, alreadyPersisted, baseUrl);
    if (batch.length > 0) {
      await batchRecordDocuments(batch);
      addLog(progress, `Phase 2: Persisted ${batch.length} discovered URLs to database`);
    }
  }

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

    let resp: FetchPageResult | null = null;
    if (isHeavyLane(fullUrl) && isScrapingApiConfigured()) {
      heavyLaneRequests++;
      const apiResp = await fetchPageViaAPI(fullUrl);
      if (apiResp && apiResp.html.length > 100) {
        resp = { html: apiResp.html, status: apiResp.status, headers: apiResp.headers, finalUrl: apiResp.finalUrl };
      }
    } else {
      fastLaneRequests++;
      resp = await fetchPage(fullUrl, signal, 8000);
    }
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
      let resp: FetchPageResult | null = null;
      if (isHeavyLane(dp) && isScrapingApiConfigured()) {
        heavyLaneRequests++;
        const apiResp = await fetchPageViaAPI(dp);
        if (apiResp && apiResp.html.length > 100) {
          resp = { html: apiResp.html, status: apiResp.status, headers: apiResp.headers, finalUrl: apiResp.finalUrl };
        }
      } else {
        fastLaneRequests++;
        resp = await fetchPage(dp, signal, 8000);
      }
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

  if (town.driveFolderId) {
    addLog(progress, '--- Phase 3c: Google Drive Discovery ---');
    if (isGoogleDriveConfigured()) {
      try {
        const driveFiles = await listFolderRecursive(town.driveFolderId, undefined, '', signal);
        let driveNewDocs = 0;
        const driveFolders = new Set<string>();
        for (const file of driveFiles) {
          driveFolders.add(file.folderPath);
          const driveUrl = `gdrive://${file.id}/${encodeURIComponent(file.name)}`;
          if (!docsSeen.has(driveUrl)) {
            docsSeen.set(driveUrl, {
              foundOnPage: `gdrive://folder/${town.driveFolderId}`,
              strategy: 'googleDrive',
              driveMimeType: file.mimeType,
              driveFolderPath: file.folderPath,
            });
            stats.googleDrive++;
            progress.documentsDiscovered++;
            driveNewDocs++;
          }
        }
        addLog(progress, `GOOGLE DRIVE: ${driveFiles.length} files found across ${driveFolders.size} folders, ${driveNewDocs} new`);
      } catch (driveErr: any) {
        addLog(progress, `GOOGLE DRIVE ERROR: ${driveErr.message}`);
      }
    } else {
      addLog(progress, 'GOOGLE DRIVE: Skipped — GOOGLE_DRIVE_API_KEY not configured');
    }
  }

  {
    const batch = buildBatchRecords(town.id, docsSeen, alreadyPersisted, baseUrl);
    if (batch.length > 0) {
      await batchRecordDocuments(batch);
      addLog(progress, `Phase 3: Persisted ${batch.length} discovered URLs to database`);
    }
  }

  addLog(progress, `--- Phase 4: Breadth-First Crawl ${isHeavyLane(baseUrl) ? '(HEAVY LANE)' : ''} ---`);
  progress.pagesQueued = queue.length;
  let progressUpdateCounter = 0;
  let consecutiveEmptyPages = 0;
  const MAX_CONSECUTIVE_EMPTY = Math.max(80, Math.min(queue.length, 150));

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
    if (isHeavyLane(pageUrl) && isScrapingApiConfigured()) {
      heavyLaneRequests++;
      const apiResp = await fetchPageViaAPI(pageUrl);
      if (apiResp && apiResp.html.length > 100) {
        page = { html: apiResp.html, status: apiResp.status, headers: apiResp.headers, finalUrl: apiResp.finalUrl };
      }
      await new Promise(r => setTimeout(r, 500));
    } else {
      fastLaneRequests++;
      page = await fetchPage(pageUrl, signal, 15000, baseUrl);
    }

    if (!page || !page.html) {
      if (page && (page.status === 403 || page.status === 429)) {
        flagHeavyLane(pageUrl);
        addLog(progress, `HEAVY LANE: ${page.status} on ${pageUrl.substring(baseUrl.length)} — domain flagged for scraping API`);
      }
      if (!page || !page.html) continue;
    }

    if (page.html && detectProtection(page.html)) {
      const protType = detectProtection(page.html)!;
      flagHeavyLane(pageUrl);

      if (isScrapingApiConfigured()) {
        heavyLaneRequests++;
        addLog(progress, `PROTECTION: ${protType} on ${pageUrl.substring(baseUrl.length)} — trying Heavy Lane`);
        const apiResp = await fetchPageViaAPI(pageUrl, { js_render: true });
        if (apiResp && apiResp.html.length > 100 && !detectProtection(apiResp.html)) {
          page = { html: apiResp.html, status: apiResp.status, headers: apiResp.headers, finalUrl: apiResp.finalUrl };
          addLog(progress, `HEAVY LANE: Protection bypassed via scraping API on ${pageUrl.substring(baseUrl.length)}`);
        } else {
          markDomainProtected(pageUrl, protType);
          if (summary.protectionStats) {
            summary.protectionStats.detected = true;
            summary.protectionStats.blockedPages++;
            if (!summary.protectionStats.types.includes(protType)) {
              summary.protectionStats.types.push(protType);
            }
          }
          addLog(progress, `PROTECTION: ${protType} on ${pageUrl.substring(baseUrl.length)} (Heavy Lane also blocked)`);
          continue;
        }
      } else {
        markDomainProtected(pageUrl, protType);
        if (summary.protectionStats) {
          summary.protectionStats.detected = true;
          summary.protectionStats.blockedPages++;
          if (!summary.protectionStats.types.includes(protType)) {
            summary.protectionStats.types.push(protType);
          }
        }
        addLog(progress, `PROTECTION: ${protType} on ${pageUrl.substring(baseUrl.length)} — domain flagged for Heavy Lane (API not configured)`);
        continue;
      }
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

    const nodeMinutesMatch = pageUrl.match(/\/node\/(\d+)\/(minutes|agenda)$/i);
    if (nodeMinutesMatch) {
      const currentYear = new Date().getFullYear();
      let yearPagesQueued = 0;
      for (let year = 2013; year <= currentYear; year++) {
        const yearUrl = `${pageUrl}/${year}`;
        if (!visited.has(yearUrl)) {
          queue.push({ url: yearUrl, depth: depth + 1, priority: 1 });
          yearPagesQueued++;
        }
      }
      if (yearPagesQueued > 0) {
        addLog(progress, `MINUTES ARCHIVE: ${pageUrl.substring(baseUrl.length)} → queued ${yearPagesQueued} year pages`);
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

    if (progressUpdateCounter % 50 === 0) {
      const batch = buildBatchRecords(town.id, docsSeen, alreadyPersisted, baseUrl);
      if (batch.length > 0) {
        await batchRecordDocuments(batch);
        addLog(progress, `BFS checkpoint: Persisted ${batch.length} discovered URLs (total known: ${alreadyPersisted.size})`);
      }
    }

    const delay = 200 + Math.random() * 500;
    await new Promise(r => setTimeout(r, delay));
  }

  {
    const batch = buildBatchRecords(town.id, docsSeen, alreadyPersisted, baseUrl);
    if (batch.length > 0) {
      await batchRecordDocuments(batch);
      addLog(progress, `Phase 4 final: Persisted ${batch.length} discovered URLs to database (total known: ${alreadyPersisted.size})`);
    }
  }

  } // end if (!isResumeMode)

  addLog(progress, `--- Phase 5: Download ${docsSeen.size} documents ---`);
  addLog(progress, `Strategy breakdown: Sitemap=${stats.sitemap}, KnownPaths=${stats.knownPaths}, BFS=${stats.breadthFirst}, External=${stats.external}, Iframe=${stats.iframe}${stats.googleDrive ? ', GoogleDrive=' + stats.googleDrive : ''}`);

  const docsToDownload = Array.from(docsSeen.entries());
  let downloadIndex = 0;
  for (const [docUrl, docInfo] of docsToDownload) {
    if (signal.aborted) break;
    downloadIndex++;

    if (docUrl.startsWith('gdrive://')) {
      const driveMatch = docUrl.match(/^gdrive:\/\/([^/]+)\/(.+)$/);
      if (!driveMatch) continue;
      const [, driveFileId, encodedName] = driveMatch;
      const driveFilename = decodeURIComponent(encodedName);
      const driveMimeType = docInfo.driveMimeType || 'application/octet-stream';
      const driveFolderPath = docInfo.driveFolderPath || '';
      const urlHash = hashUrl(docUrl);
      const driveBoard = driveFolderPath.split('/')[0] || undefined;
      const driveYear = driveFolderPath.match(/\b(20\d{2}|19\d{2})\b/)?.[1] || undefined;
      const pdfName = driveFilename.replace(/\.[^.]+$/, '.pdf');
      const s3Key = `${town.slug}/gdrive/${driveFolderPath ? driveFolderPath + '/' : ''}${pdfName}`.replace(/\/+/g, '/');

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
          const existDoc = await recordDocument({
            townId: town.id,
            url: docUrl,
            urlHash,
            filename: pdfName,
            category: 'minutes',
            board: driveBoard,
            year: driveYear,
            s3Key,
            status: 'uploaded',
            discoveredFrom: docInfo.foundOnPage,
            s3UploadedAt: new Date(),
          });
          await bridgeToFileBlob(existDoc.id, { s3Key, filename: pdfName, mimeType: 'application/pdf', sizeBytes: 0 });
          progress.duplicatesSkipped++;
          summary.duplicates++;
          continue;
        }

        const driveDoc = await downloadDriveFile(driveFileId, driveMimeType, undefined, signal);
        await uploadToS3(s3, s3Key, driveDoc.buffer, driveDoc.contentType);
        const newDriveDoc = await recordDocument({
          townId: town.id,
          url: docUrl,
          urlHash,
          filename: pdfName,
          category: 'minutes',
          board: driveBoard,
          year: driveYear,
          s3Key,
          sizeBytes: driveDoc.size,
          mimeType: driveDoc.contentType,
          status: 'uploaded',
          discoveredFrom: docInfo.foundOnPage,
          s3UploadedAt: new Date(),
        });
        await bridgeToFileBlob(newDriveDoc.id, { s3Key, filename: pdfName, mimeType: driveDoc.contentType, sizeBytes: driveDoc.size });
        progress.documentsDownloaded++;
        summary.newDocuments++;
        if (driveBoard) {
          summary.byBoard[driveBoard] = (summary.byBoard[driveBoard] || 0) + 1;
        }
        summary.byCategory['minutes'] = (summary.byCategory['minutes'] || 0) + 1;
        if (downloadIndex % 10 === 0 || progress.documentsDownloaded <= 5) {
          addLog(progress, `DRIVE OK [${downloadIndex}/${docsSeen.size}]: ${pdfName} (${Math.round(driveDoc.size / 1024)}KB) [${driveFolderPath}]`);
        }
      } catch (e: any) {
        const failureType = classifyError(e);
        progress.documentsFailed++;
        summary.errors.push({ url: docUrl, error: e.message || 'Unknown error', failureType });
        if (summary.failuresByType) {
          summary.failuresByType[failureType] = (summary.failuresByType[failureType] || 0) + 1;
        }
        await recordDocument({
          townId: town.id,
          url: docUrl,
          urlHash,
          filename: pdfName,
          category: 'minutes',
          board: driveBoard,
          year: driveYear,
          status: 'failed',
          discoveredFrom: docInfo.foundOnPage,
        }).catch(() => {});
        if (progress.documentsFailed <= 20 || progress.documentsFailed % 50 === 0) {
          addLog(progress, `DRIVE FAIL [${downloadIndex}/${docsSeen.size}]: ${driveFilename} - ${e.message}`);
        }
      }

      if (downloadIndex % 20 === 0) {
        await updateRunProgress(run.id, progress);
        await new Promise(r => setTimeout(r, 100));
      }
      continue;
    }

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
        const existDoc = await recordDocument({
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
        await bridgeToFileBlob(existDoc.id, { s3Key, filename, mimeType: 'application/pdf', sizeBytes: 0 });
        progress.duplicatesSkipped++;
        summary.duplicates++;
        continue;
      }

      let doc: FetchDocumentResult | null = null;

      if (isCivicPlusRedirectUrl(docUrl) && isScrapingApiConfigured()) {
        heavyLaneRequests++;
        const resolved = await resolveRedirectViaAPI(docUrl);
        if (resolved) {
          const finalPdfUrl = resolved.finalUrl.startsWith('http')
            ? resolved.finalUrl
            : new URL(resolved.finalUrl, docUrl).href;
          addLog(progress, `REDIRECT RESOLVE: ${filename} → ${finalPdfUrl.substring(finalPdfUrl.lastIndexOf('/') + 1)}`);
          const localDoc = await fetchDocumentWithCookies(finalPdfUrl, resolved.cookies, signal);
          if (localDoc) {
            doc = { ...localDoc, isInterstitial: false };
            interstitialsBypassed++;
          }
        }
        if (!doc) {
          addLog(progress, `REDIRECT RESOLVE failed for: ${filename} — falling back to direct fetch`);
        }
      }

      if (!doc) {
        fastLaneRequests++;
        doc = await fetchDocument(docUrl, signal, docInfo.foundOnPage).catch(async (e: any) => {
          if (isHeavyLane(docUrl) && isScrapingApiConfigured() && (e.message?.includes('403') || e.message?.includes('429'))) {
            heavyLaneRequests++;
            addLog(progress, `HEAVY LANE fallback for doc: ${filename}`);
            const apiDoc = await fetchDocumentViaAPI(docUrl);
            if (apiDoc) return { ...apiDoc, isInterstitial: false };
          }
          throw e;
        });
      }

      if (doc && doc.isInterstitial) {
        addLog(progress, `INTERSTITIAL detected for: ${filename}`);
        let resolved = false;
        if (isScrapingApiConfigured()) {
          heavyLaneRequests++;
          const apiResult = await fetchPageViaAPI(docUrl, { js_render: true });
          if (apiResult) {
            const finalUrl = extractFinalUrlFromInterstitial(apiResult.html);
            const cookies = apiResult.cookies || [];
            if (finalUrl) {
              const absoluteUrl = finalUrl.startsWith('http') ? finalUrl : new URL(finalUrl, docUrl).href;
              addLog(progress, `INTERSTITIAL bypass: extracted URL ${absoluteUrl} with ${cookies.length} cookies`);
              const cookieDoc = await fetchDocumentWithCookies(absoluteUrl, cookies, signal);
              if (cookieDoc) {
                doc = { ...cookieDoc, isInterstitial: false };
                interstitialsBypassed++;
                resolved = true;
              }
            }
            if (!resolved && cookies.length > 0) {
              const cookieDoc = await fetchDocumentWithCookies(docUrl, cookies, signal);
              if (cookieDoc) {
                doc = { ...cookieDoc, isInterstitial: false };
                interstitialsBypassed++;
                resolved = true;
              }
            }
          }
        }
        if (!resolved) {
          throw new Error('Interstitial page detected, could not extract final document URL');
        }
      }

      if (doc && !doc.isInterstitial && doc.size > 0) {
        await uploadToS3(s3, s3Key, doc.buffer, doc.contentType);
        const newDoc = await recordDocument({
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
        await bridgeToFileBlob(newDoc.id, { s3Key, filename, mimeType: doc.contentType, sizeBytes: doc.size });
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

  progress.completedAt = new Date();
  progress.currentUrl = '';

  const durationMs = progress.completedAt.getTime() - progress.startedAt.getTime();
  const durationSec = Math.round(durationMs / 1000);
  const durationStr = durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`;

  const attemptedDownloads = progress.documentsDownloaded + progress.documentsFailed;
  const downloadSuccessRate = attemptedDownloads > 0
    ? ((progress.documentsDownloaded / attemptedDownloads) * 100).toFixed(1)
    : 'N/A';
  const coverageRate = progress.documentsDiscovered > 0
    ? ((progress.duplicatesSkipped / progress.documentsDiscovered) * 100).toFixed(1)
    : '0';

  const failureSummaryParts: string[] = [];
  if (summary.failuresByType) {
    for (const [type, count] of Object.entries(summary.failuresByType)) {
      failureSummaryParts.push(`${count}x ${type}`);
    }
  }
  const failureSummaryStr = failureSummaryParts.length > 0 ? failureSummaryParts.join(', ') : 'none';

  let finalStatus: 'completed' | 'completed_with_errors' | 'failed';
  let statusReason: string;

  const blockedPages = summary.protectionStats?.blockedPages || 0;
  const blockedDocs = summary.protectionStats?.blockedDocuments || 0;
  const siteCompletelyBlocked = progress.pagesVisited <= 2 && blockedPages > 10;
  const highFailureRate = attemptedDownloads > 0 && (progress.documentsFailed / attemptedDownloads) > 0.5;
  const allNewFailed = attemptedDownloads > 0 && progress.documentsDownloaded === 0 && progress.documentsFailed > 0;
  const significantDocFailures = blockedDocs > 5;

  if (siteCompletelyBlocked) {
    finalStatus = 'failed';
    statusReason = `Site completely blocked — only ${progress.pagesVisited} pages visited, ${blockedPages} pages blocked by protection`;
  } else if (allNewFailed) {
    finalStatus = 'completed_with_errors';
    if (progress.duplicatesSkipped > 0) {
      statusReason = `All ${progress.documentsFailed} new download attempts failed (${failureSummaryStr}), but ${progress.duplicatesSkipped} existing docs confirmed`;
    } else {
      statusReason = `All ${progress.documentsFailed} download attempts failed (${failureSummaryStr})`;
    }
  } else if (highFailureRate && attemptedDownloads >= 5) {
    finalStatus = 'completed_with_errors';
    statusReason = `High failure rate: ${progress.documentsFailed} of ${attemptedDownloads} downloads failed (${downloadSuccessRate}% success). Failures: ${failureSummaryStr}`;
  } else if (significantDocFailures) {
    finalStatus = 'completed_with_errors';
    statusReason = `${blockedDocs} documents blocked by site protection (${failureSummaryStr})`;
  } else {
    finalStatus = 'completed';
    if (progress.documentsDownloaded > 0) {
      statusReason = `${progress.documentsDownloaded} new docs uploaded, ${progress.duplicatesSkipped} duplicates confirmed`;
      if (progress.documentsFailed > 0) {
        statusReason += `. ${progress.documentsFailed} stale links returned errors (${failureSummaryStr})`;
      }
    } else if (progress.duplicatesSkipped > 0) {
      statusReason = `No new docs — all ${progress.duplicatesSkipped} discovered docs already in database (${coverageRate}% coverage)`;
      if (progress.documentsFailed > 0) {
        statusReason += `. ${progress.documentsFailed} stale links returned errors (${failureSummaryStr})`;
      }
    } else if (progress.documentsDiscovered > 0) {
      statusReason = `${progress.documentsDiscovered} docs discovered but none were new or downloadable`;
    } else {
      statusReason = `No documents discovered on this site`;
    }
  }

  progress.status = finalStatus === 'completed_with_errors' ? 'completed_with_errors' : finalStatus;

  const errorMessageForDb = finalStatus === 'completed' ? null
    : finalStatus === 'completed_with_errors' ? statusReason
    : statusReason;

  addLog(progress, `=== CRAWL SUMMARY ===`);
  addLog(progress, `STATUS: ${finalStatus} — ${statusReason}`);
  addLog(progress, `DURATION: ${durationStr}`);
  addLog(progress, `PAGES: ${progress.pagesVisited} visited, ${blockedPages} blocked by protection`);
  addLog(progress, `DISCOVERY: ${progress.documentsDiscovered} docs found — Strategy: Sitemap=${stats.sitemap}, KnownPaths=${stats.knownPaths}, BFS=${stats.breadthFirst}, External=${stats.external}, Iframe=${stats.iframe}${stats.googleDrive ? ', GoogleDrive=' + stats.googleDrive : ''}`);
  addLog(progress, `DUPLICATES: ${progress.duplicatesSkipped} of ${progress.documentsDiscovered} docs already in database (${coverageRate}% prior coverage)`);
  addLog(progress, `DOWNLOADS: ${progress.documentsDownloaded} succeeded, ${progress.documentsFailed} failed of ${attemptedDownloads} attempted (${downloadSuccessRate}% success rate)`);
  if (progress.documentsFailed > 0) {
    addLog(progress, `FAILURES: ${failureSummaryStr}`);
  }
  addLog(progress, `REQUESTS: Fast Lane=${fastLaneRequests}, Heavy Lane=${heavyLaneRequests}, Interstitials Bypassed=${interstitialsBypassed}`);
  if (heavyLaneDomains.size > 0) {
    addLog(progress, `HEAVY LANE DOMAINS: ${Array.from(heavyLaneDomains).join(', ')}`);
  }
  if (summary.protectionStats?.detected) {
    const protTypes = summary.protectionStats.types?.join(', ') || 'unknown';
    addLog(progress, `PROTECTION: ${protTypes} detected, ${blockedPages} pages blocked, ${blockedDocs} docs blocked`);
  }
  addLog(progress, `=== END SUMMARY ===`);

  (summary as any).strategyStats = stats;
  (summary as any).detectedCms = detectedCms;
  (summary as any).protectionDetected = progress.protectionDetected;
  (summary as any).fastLaneRequests = fastLaneRequests;
  (summary as any).heavyLaneRequests = heavyLaneRequests;
  (summary as any).interstitialsBypassed = interstitialsBypassed;
  (summary as any).statusReason = statusReason;

  await db.update(crawlerRuns)
    .set({
      status: finalStatus,
      completedAt: new Date(),
      pagesVisited: progress.pagesVisited,
      documentsDiscovered: progress.documentsDiscovered,
      documentsUploaded: progress.documentsDownloaded,
      documentsFailed: progress.documentsFailed,
      errorMessage: errorMessageForDb,
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

// ============================================================
// STATE SOURCE CRAWLING
// ============================================================

interface StateCrawlOptions {
  maxPages?: number;
  mode?: string;
  targetPaths?: string[];
  linkPatterns?: string[];
  excludePatterns?: string[];
}

function matchesExcludePattern(url: string, text: string, excludePatterns: string[]): boolean {
  if (excludePatterns.length === 0) return false;
  const lowerUrl = url.toLowerCase();
  const lowerText = text.toLowerCase();
  for (const pattern of excludePatterns) {
    const lowerPattern = pattern.toLowerCase();
    if (lowerUrl.includes(lowerPattern)) return true;
    if (lowerText.includes(lowerPattern)) return true;
  }
  return false;
}

function matchesLinkPattern(text: string, linkPatterns: string[]): boolean {
  if (linkPatterns.length === 0) return true;
  const lowerText = text.toLowerCase();
  for (const pattern of linkPatterns) {
    if (lowerText.includes(pattern.toLowerCase())) return true;
  }
  return false;
}

function extractLinksWithContext(html: string, pageUrl: string): Array<{ href: string; text: string; parentText: string }> {
  const results: Array<{ href: string; text: string; parentText: string }> = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  const linkRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  const parentBlocks = new Map<string, string>();

  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const blockHtml = m[1];
    const blockText = blockHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const innerLinks = /<a\s[^>]*href=["']([^"']+)["']/gi;
    let lm;
    while ((lm = innerLinks.exec(blockHtml)) !== null) {
      const resolved = normalizeUrl(lm[1], pageUrl);
      if (resolved) parentBlocks.set(resolved, blockText);
    }
  }
  while ((m = liRegex.exec(html)) !== null) {
    const blockHtml = m[1];
    const blockText = blockHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const innerLinks = /<a\s[^>]*href=["']([^"']+)["']/gi;
    let lm;
    while ((lm = innerLinks.exec(blockHtml)) !== null) {
      const resolved = normalizeUrl(lm[1], pageUrl);
      if (resolved && !parentBlocks.has(resolved)) parentBlocks.set(resolved, blockText);
    }
  }

  while ((m = linkRegex.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    const resolved = normalizeUrl(href, pageUrl);
    if (resolved) {
      results.push({
        href: resolved,
        text,
        parentText: parentBlocks.get(resolved) || text,
      });
    }
  }
  return results;
}

function buildStateBatchRecords(
  sourceId: string,
  docsSeen: Map<string, { foundOnPage: string; strategy: keyof StrategyStats; linkText?: string }>,
  alreadyPersisted: Set<string>,
  baseUrl: string,
): InsertCrawlerStateDocument[] {
  const records: InsertCrawlerStateDocument[] = [];
  for (const [url, info] of docsSeen) {
    if (alreadyPersisted.has(url)) continue;
    const urlH = hashUrl(url);
    const filename = extractFilename(url);
    records.push({
      sourceId,
      url,
      urlHash: urlH,
      filename,
      discoveredFrom: info.foundOnPage,
      status: 'discovered',
      title: info.linkText || undefined,
    });
    alreadyPersisted.add(url);
  }
  return records;
}

export function generateStateS3Key(sourceSlug: string, url: string, filename: string): string {
  const sanitized = filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    const subPath = pathParts.slice(0, -1).slice(0, 3).join('/');
    if (subPath) {
      return `state/${sourceSlug}/${subPath}/${sanitized}`;
    }
  } catch {}
  return `state/${sourceSlug}/${sanitized}`;
}

export async function bridgeStateDocToFileBlob(stateDocId: string, opts: {
  s3Key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceSlug: string;
  agency?: string;
}): Promise<void> {
  try {
    const rawHash = `s3:${opts.s3Key}`;
    const existing = await db.execute(
      sql`SELECT id FROM file_blobs WHERE raw_hash = ${rawHash}`
    );
    let fileBlobId: string;
    if (existing.rows.length > 0) {
      fileBlobId = (existing.rows[0] as any).id;
    } else {
      const storagePath = `s3://${S3_BUCKET}/${opts.s3Key}`;
      const [blob] = await db
        .insert(schema.fileBlobs)
        .values({
          rawHash,
          sizeBytes: opts.sizeBytes || 0,
          mimeType: opts.mimeType || 'application/pdf',
          originalFilename: opts.filename || opts.s3Key.split('/').pop() || 'unknown.pdf',
          storagePath,
          s3Bucket: S3_BUCKET,
          s3Key: opts.s3Key,
          needsOcr: false,
          ocrStatus: 'none',
          extractedTextCharCount: 0,
          embeddingStatus: 'none',
        })
        .returning();
      fileBlobId = blob.id;
    }
    await db.execute(sql`
      UPDATE crawler_state_documents SET file_blob_id = ${fileBlobId} WHERE id = ${stateDocId} AND file_blob_id IS NULL
    `);
  } catch (e: any) {
    console.warn(`[StateCrawlEngine] bridgeStateDocToFileBlob failed for ${opts.s3Key}: ${e.message}`);
  }
}

export async function startStateCrawl(
  source: CrawlerStateSource,
  run: CrawlerStateSourceRun,
  options: StateCrawlOptions = {}
): Promise<string> {
  const runId = run.id;
  if (activeCrawls.has(runId)) {
    throw new Error('Crawl already running for this run ID');
  }

  const abortController = new AbortController();
  const progress: CrawlProgress = {
    runId,
    townId: source.id,
    townName: `[STATE] ${source.name}`,
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
    strategyStats: { sitemap: 0, knownPaths: 0, breadthFirst: 0, external: 0, iframe: 0, googleDrive: 0 },
  };

  const job: CrawlJob = { progress, abortController };
  activeCrawls.set(runId, job);

  executeStateCrawl(source, run, job, options).catch(async (err) => {
    progress.status = 'failed';
    progress.errorMessage = err.message;
    addLog(progress, `FATAL: Unhandled exception — ${err.message}`);
    addLog(progress, `FATAL: Stack — ${err.stack?.split('\n').slice(0, 3).join(' | ') || 'no stack'}`);

    try {
      await completeStateSourceRun(run.id, 'failed', {
        pagesVisited: progress.pagesVisited,
        documentsDiscovered: progress.documentsDiscovered,
        documentsDownloaded: progress.documentsDownloaded,
        documentsUploaded: progress.documentsDownloaded,
        documentsFailed: progress.documentsFailed,
        errorMessage: `CRASH: ${err.message}`,
      });
    } catch (dbErr: any) {
      addLog(progress, `FATAL: Could not persist crash state to DB — ${dbErr.message}`);
    }

    setTimeout(() => activeCrawls.delete(runId), 300000);
  });

  return runId;
}

async function executeStateCrawl(
  source: CrawlerStateSource,
  run: CrawlerStateSourceRun,
  job: CrawlJob,
  options: StateCrawlOptions
) {
  const { progress, abortController } = job;
  const signal = abortController.signal;
  const maxPages = options.maxPages || source.maxPages || 500;
  const baseUrl = source.baseUrl.replace(/\/$/, '');
  const baseHostname = new URL(baseUrl).hostname;

  const targetPaths = options.targetPaths || (source.targetPaths as string[]) || [];
  const linkPatterns = options.linkPatterns || (source.linkPatterns as string[]) || [];
  const excludePatterns = options.excludePatterns || (source.excludePatterns as string[]) || [];
  const hasLinkFilter = linkPatterns.length > 0;

  const s3 = new S3Client({ region: S3_REGION });

  addLog(progress, `Starting STATE SOURCE crawl of ${source.name} (${source.agency})`);
  addLog(progress, `Base URL: ${baseUrl}`);
  addLog(progress, `Max pages: ${maxPages}, Mode: ${options.mode || 'full'}`);
  if (targetPaths.length > 0) addLog(progress, `Target paths: ${targetPaths.join(', ')}`);
  if (linkPatterns.length > 0) addLog(progress, `Link text filters: ${linkPatterns.join(', ')}`);
  if (excludePatterns.length > 0) addLog(progress, `Exclude patterns: ${excludePatterns.join(', ')}`);

  const visited = new Set<string>();
  const docsSeen = new Map<string, { foundOnPage: string; strategy: keyof StrategyStats; linkText?: string }>();
  const alreadyPersisted = new Set<string>();
  const queue: Array<{ url: string; depth: number; priority: number }> = [];

  addLog(progress, 'Pre-seeding from database...');
  const existingDocs = await getAllStateDocumentUrls(source.id);
  let preSeededUploaded = 0;
  let preSeededOther = 0;
  for (const doc of existingDocs) {
    docsSeen.set(doc.url, { foundOnPage: doc.discoveredFrom || 'db-preseed', strategy: 'breadthFirst' });
    alreadyPersisted.add(doc.url);
    if (doc.status === 'uploaded') preSeededUploaded++;
    else preSeededOther++;
  }
  addLog(progress, `Pre-seeded ${existingDocs.length} known URLs (${preSeededUploaded} uploaded, ${preSeededOther} discovered/failed)`);

  const isResumeMode = options.mode === 'resume';

  if (isResumeMode) {
    addLog(progress, '=== RESUME MODE: Skipping discovery, loading pending downloads from DB ===');
    docsSeen.clear();
    const resumableDocs = await getResumableStateDocuments(source.id);
    addLog(progress, `RESUME MODE: Found ${resumableDocs.length} documents to retry`);
    for (const doc of resumableDocs) {
      docsSeen.set(doc.url, { foundOnPage: doc.discoveredFrom || 'resume', strategy: 'breadthFirst' });
    }
    progress.documentsDiscovered = resumableDocs.length;
  }

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

  const heavyLaneDomains = new Set<string>();
  let heavyLaneRequests = 0;
  let fastLaneRequests = 0;
  let linkFilterSkipped = 0;
  let excludeFilterSkipped = 0;

  const flagHeavyLane = (url: string) => {
    try { heavyLaneDomains.add(new URL(url).hostname); } catch {}
  };
  const isHeavyLane = (url: string): boolean => {
    try { return heavyLaneDomains.has(new URL(url).hostname); } catch { return false; }
  };

  if (!isResumeMode) {
  addLog(progress, '--- Phase 1: Homepage Fetch ---');
  fastLaneRequests++;
  const homepage = await fetchHomepage(baseUrl, signal);
  if (!homepage || !homepage.html) {
    if ((homepage as any)?.needsHeavyLane) {
      flagHeavyLane(baseUrl);
      addLog(progress, `HEAVY LANE: Homepage blocked (status: ${homepage?.status || 'timeout'}). Domain flagged for scraping API.`);
    }
    addLog(progress, `WARNING: Could not fetch homepage at ${baseUrl}`);
  } else {
    if ((homepage as any)?.viaHeavyLane) {
      flagHeavyLane(baseUrl);
      heavyLaneRequests++;
      addLog(progress, `HEAVY LANE: Homepage retrieved via scraping API. Domain flagged for Heavy Lane.`);
    }
    const protection = detectProtection(homepage.html);
    if (protection) {
      progress.protectionDetected = protection;
      flagHeavyLane(baseUrl);
      addLog(progress, `WARNING: ${protection} protection detected on homepage. Domain flagged for Heavy Lane.`);
      if (summary.protectionStats) {
        summary.protectionStats.detected = true;
        if (!summary.protectionStats.types.includes(protection)) {
          summary.protectionStats.types.push(protection);
        }
      }
    }
    progress.pagesVisited++;
    visited.add(baseUrl);

    const homeLinks = extractLinksWithContext(homepage.html, baseUrl);
    let homeDocsFound = 0;
    for (const link of homeLinks) {
      if (matchesExcludePattern(link.href, link.parentText, excludePatterns)) {
        excludeFilterSkipped++;
        continue;
      }
      if (isDocumentUrl(link.href) && !docsSeen.has(link.href)) {
        if (hasLinkFilter && !matchesLinkPattern(link.parentText, linkPatterns)) {
          linkFilterSkipped++;
          continue;
        }
        docsSeen.set(link.href, { foundOnPage: baseUrl, strategy: 'breadthFirst', linkText: link.text });
        stats.breadthFirst++;
        progress.documentsDiscovered++;
        homeDocsFound++;
      } else if (isNavigationLink(link.href, baseHostname) && !visited.has(link.href)) {
        const prio = isHighPriorityUrl(link.href) ? 1 : 3;
        queue.push({ url: link.href, depth: 1, priority: prio });
      }
    }
    addLog(progress, `Homepage: ${homeLinks.length} links, ${homeDocsFound} docs queued`);
  }

  {
    const batch = buildStateBatchRecords(source.id, docsSeen, alreadyPersisted, baseUrl);
    if (batch.length > 0) {
      await batchRecordStateDocuments(batch);
      addLog(progress, `Phase 1: Persisted ${batch.length} discovered URLs to database`);
    }
  }

  addLog(progress, '--- Phase 2: Sitemap Discovery ---');
  const sitemapUrls = [
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
  ];
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
        if (matchesExcludePattern(u, '', excludePatterns)) {
          excludeFilterSkipped++;
          continue;
        }
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

  {
    const batch = buildStateBatchRecords(source.id, docsSeen, alreadyPersisted, baseUrl);
    if (batch.length > 0) {
      await batchRecordStateDocuments(batch);
      addLog(progress, `Phase 2: Persisted ${batch.length} discovered URLs to database`);
    }
  }

  addLog(progress, '--- Phase 3: Target Path Probing ---');
  let validPaths = 0;
  let targetPathDocsFound = 0;

  for (const p of targetPaths) {
    if (signal.aborted) break;
    const fullUrl = p.startsWith('http') ? p : `${baseUrl}${p}`;
    if (visited.has(fullUrl)) continue;

    let resp: FetchPageResult | null = null;
    if (isHeavyLane(fullUrl) && isScrapingApiConfigured()) {
      heavyLaneRequests++;
      const apiResp = await fetchPageViaAPI(fullUrl);
      if (apiResp && apiResp.html.length > 100) {
        resp = { html: apiResp.html, status: apiResp.status, headers: apiResp.headers, finalUrl: apiResp.finalUrl };
      }
    } else {
      fastLaneRequests++;
      resp = await fetchPage(fullUrl, signal, 8000);
      if (resp && (resp.status === 403 || resp.status === 429 || (resp.html && detectProtection(resp.html)))) {
        flagHeavyLane(fullUrl);
        addLog(progress, `HEAVY LANE: Target path ${p} blocked (${resp.status}). Retrying via scraping API.`);
        if (isScrapingApiConfigured()) {
          heavyLaneRequests++;
          const apiResp = await fetchPageViaAPI(fullUrl);
          if (apiResp && apiResp.html.length > 100) {
            resp = { html: apiResp.html, status: apiResp.status, headers: apiResp.headers, finalUrl: apiResp.finalUrl };
          }
        }
      }
    }
    if (resp && resp.status === 200 && resp.html.length > 500) {
      validPaths++;
      visited.add(fullUrl);
      progress.pagesVisited++;

      const links = extractLinksWithContext(resp.html, fullUrl);
      let pathDocsCount = 0;
      for (const link of links) {
        if (matchesExcludePattern(link.href, link.parentText, excludePatterns)) {
          excludeFilterSkipped++;
          continue;
        }
        if (isDocumentUrl(link.href) && !docsSeen.has(link.href)) {
          if (hasLinkFilter && !matchesLinkPattern(link.parentText, linkPatterns)) {
            linkFilterSkipped++;
            continue;
          }
          docsSeen.set(link.href, { foundOnPage: fullUrl, strategy: 'knownPaths', linkText: link.text });
          stats.knownPaths++;
          progress.documentsDiscovered++;
          pathDocsCount++;
          targetPathDocsFound++;
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

      if (pathDocsCount > 0) {
        addLog(progress, `TargetPath ${p}: ${pathDocsCount} docs found`);
      }
    } else {
      addLog(progress, `TargetPath ${p}: failed (status: ${resp?.status || 'null'}, size: ${resp?.html?.length || 0})`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  addLog(progress, `Target paths: ${validPaths} valid out of ${targetPaths.length} probed, ${targetPathDocsFound} docs found`);

  {
    const batch = buildStateBatchRecords(source.id, docsSeen, alreadyPersisted, baseUrl);
    if (batch.length > 0) {
      await batchRecordStateDocuments(batch);
      addLog(progress, `Phase 3: Persisted ${batch.length} discovered URLs to database`);
    }
  }

  addLog(progress, `--- Phase 4: Breadth-First Crawl ${isHeavyLane(baseUrl) ? '(HEAVY LANE)' : ''} ---`);
  progress.pagesQueued = queue.length;
  let progressUpdateCounter = 0;
  let consecutiveEmptyPages = 0;
  const MAX_CONSECUTIVE_EMPTY = Math.max(40, Math.min(queue.length, 100));

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
    if (matchesExcludePattern(pageUrl, '', excludePatterns)) {
      excludeFilterSkipped++;
      continue;
    }

    progress.currentUrl = pageUrl;
    progress.pagesQueued = queue.length;

    let page: FetchPageResult | null = null;
    if (isHeavyLane(pageUrl) && isScrapingApiConfigured()) {
      heavyLaneRequests++;
      const apiResp = await fetchPageViaAPI(pageUrl);
      if (apiResp && apiResp.html.length > 100) {
        page = { html: apiResp.html, status: apiResp.status, headers: apiResp.headers, finalUrl: apiResp.finalUrl };
      }
      await new Promise(r => setTimeout(r, 500));
    } else {
      fastLaneRequests++;
      page = await fetchPage(pageUrl, signal, 15000, baseUrl);
    }

    if (!page || !page.html) {
      if (page && (page.status === 403 || page.status === 429)) {
        flagHeavyLane(pageUrl);
      }
      continue;
    }

    if (page.status === 403 || page.status === 429) {
      flagHeavyLane(pageUrl);
      if (isScrapingApiConfigured()) {
        heavyLaneRequests++;
        const apiResp = await fetchPageViaAPI(pageUrl);
        if (apiResp && apiResp.html.length > 100 && apiResp.status === 200) {
          page = { html: apiResp.html, status: apiResp.status, headers: apiResp.headers, finalUrl: apiResp.finalUrl };
        } else {
          if (summary.protectionStats) {
            summary.protectionStats.detected = true;
            summary.protectionStats.blockedPages++;
          }
          continue;
        }
      } else {
        if (summary.protectionStats) {
          summary.protectionStats.detected = true;
          summary.protectionStats.blockedPages++;
        }
        continue;
      }
    }

    if (page.html && detectProtection(page.html)) {
      const protType = detectProtection(page.html)!;
      flagHeavyLane(pageUrl);
      if (isScrapingApiConfigured()) {
        heavyLaneRequests++;
        const apiResp = await fetchPageViaAPI(pageUrl, { js_render: true });
        if (apiResp && apiResp.html.length > 100 && !detectProtection(apiResp.html)) {
          page = { html: apiResp.html, status: apiResp.status, headers: apiResp.headers, finalUrl: apiResp.finalUrl };
        } else {
          markDomainProtected(pageUrl, protType);
          if (summary.protectionStats) {
            summary.protectionStats.detected = true;
            summary.protectionStats.blockedPages++;
          }
          continue;
        }
      } else {
        markDomainProtected(pageUrl, protType);
        if (summary.protectionStats) {
          summary.protectionStats.detected = true;
          summary.protectionStats.blockedPages++;
        }
        continue;
      }
    }

    progress.pagesVisited++;
    let pageDocsFound = 0;

    const links = extractLinksWithContext(page.html, pageUrl);
    for (const link of links) {
      if (matchesExcludePattern(link.href, link.parentText, excludePatterns)) {
        excludeFilterSkipped++;
        continue;
      }
      if (isDocumentUrl(link.href) && !docsSeen.has(link.href)) {
        if (hasLinkFilter && !matchesLinkPattern(link.parentText, linkPatterns)) {
          linkFilterSkipped++;
          continue;
        }
        docsSeen.set(link.href, { foundOnPage: pageUrl, strategy: 'breadthFirst', linkText: link.text });
        pageDocsFound++;
        stats.breadthFirst++;
        progress.documentsDiscovered++;
      }

      if (depth < 4 && !visited.has(link.href) && isNavigationLink(link.href, baseHostname)) {
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

    if (pageDocsFound > 0) {
      consecutiveEmptyPages = 0;
      addLog(progress, `Page ${progress.pagesVisited}: ${pageDocsFound} docs on ${pageUrl.substring(baseUrl.length) || '/'}`);
    } else {
      consecutiveEmptyPages++;
    }

    progressUpdateCounter++;
    if (progressUpdateCounter % 5 === 0) {
      await updateStateRunProgress(run.id, progress);
    }

    if (progressUpdateCounter % 50 === 0) {
      const batch = buildStateBatchRecords(source.id, docsSeen, alreadyPersisted, baseUrl);
      if (batch.length > 0) {
        await batchRecordStateDocuments(batch);
        addLog(progress, `BFS checkpoint: Persisted ${batch.length} discovered URLs`);
      }
    }

    const delay = 200 + Math.random() * 500;
    await new Promise(r => setTimeout(r, delay));
  }

  {
    const batch = buildStateBatchRecords(source.id, docsSeen, alreadyPersisted, baseUrl);
    if (batch.length > 0) {
      await batchRecordStateDocuments(batch);
      addLog(progress, `Phase 4 final: Persisted ${batch.length} discovered URLs to database`);
    }
  }

  } // end if (!isResumeMode)

  if (hasLinkFilter) {
    addLog(progress, `LINK FILTER: ${linkFilterSkipped} docs skipped (link text did not match patterns)`);
  }
  if (excludePatterns.length > 0) {
    addLog(progress, `EXCLUDE FILTER: ${excludeFilterSkipped} URLs/links skipped by exclude patterns`);
  }

  addLog(progress, `--- Phase 5: Download ${docsSeen.size} documents ---`);
  addLog(progress, `Strategy breakdown: Sitemap=${stats.sitemap}, KnownPaths=${stats.knownPaths}, BFS=${stats.breadthFirst}, Iframe=${stats.iframe}`);

  const docsToDownload = Array.from(docsSeen.entries());
  let downloadIndex = 0;
  for (const [docUrl, docInfo] of docsToDownload) {
    if (signal.aborted) break;
    downloadIndex++;

    if (isExternalDocumentLink(docUrl)) {
      await recordStateDocument({
        sourceId: source.id,
        url: docUrl,
        urlHash: hashUrl(docUrl),
        filename: extractFilename(docUrl),
        status: 'discovered',
        discoveredFrom: docInfo.foundOnPage,
      });
      continue;
    }

    const urlHash = hashUrl(docUrl);
    const filename = extractFilename(docUrl);
    const s3Key = generateStateS3Key(source.slug, docUrl, filename);

    const existing = await db.select({ id: crawlerStateDocuments.id, status: crawlerStateDocuments.status })
      .from(crawlerStateDocuments)
      .where(eq(crawlerStateDocuments.urlHash, urlHash))
      .limit(1);

    if (existing.length > 0 && existing[0].status === 'uploaded') {
      progress.duplicatesSkipped++;
      summary.duplicates++;
      continue;
    }

    try {
      if (await s3KeyExists(s3, s3Key)) {
        const existDoc = await recordStateDocument({
          sourceId: source.id,
          url: docUrl,
          urlHash,
          filename,
          s3Key,
          status: 'uploaded',
          discoveredFrom: docInfo.foundOnPage,
          s3UploadedAt: new Date(),
          title: docInfo.linkText || undefined,
        });
        await bridgeStateDocToFileBlob(existDoc.id, { s3Key, filename, mimeType: 'application/pdf', sizeBytes: 0, sourceSlug: source.slug, agency: source.agency });
        progress.duplicatesSkipped++;
        summary.duplicates++;
        continue;
      }

      let doc: FetchDocumentResult | null = null;

      if (!doc) {
        fastLaneRequests++;
        doc = await fetchDocument(docUrl, signal, docInfo.foundOnPage).catch(async (e: any) => {
          if (isHeavyLane(docUrl) && isScrapingApiConfigured() && (e.message?.includes('403') || e.message?.includes('429'))) {
            heavyLaneRequests++;
            addLog(progress, `HEAVY LANE fallback for doc: ${filename}`);
            const apiDoc = await fetchDocumentViaAPI(docUrl);
            if (apiDoc) return { ...apiDoc, isInterstitial: false };
          }
          throw e;
        });
      }

      if (doc && doc.isInterstitial) {
        addLog(progress, `INTERSTITIAL detected for: ${filename}`);
        let resolved = false;
        if (isScrapingApiConfigured()) {
          heavyLaneRequests++;
          const apiResult = await fetchPageViaAPI(docUrl, { js_render: true });
          if (apiResult) {
            const finalUrl = extractFinalUrlFromInterstitial(apiResult.html);
            const cookies = apiResult.cookies || [];
            if (finalUrl) {
              const absoluteUrl = finalUrl.startsWith('http') ? finalUrl : new URL(finalUrl, docUrl).href;
              const cookieDoc = await fetchDocumentWithCookies(absoluteUrl, cookies, signal);
              if (cookieDoc) {
                doc = { ...cookieDoc, isInterstitial: false };
                resolved = true;
              }
            }
            if (!resolved && cookies.length > 0) {
              const cookieDoc = await fetchDocumentWithCookies(docUrl, cookies, signal);
              if (cookieDoc) {
                doc = { ...cookieDoc, isInterstitial: false };
                resolved = true;
              }
            }
          }
        }
        if (!resolved) {
          throw new Error('Interstitial page detected, could not extract final document URL');
        }
      }

      if (doc && !doc.isInterstitial && doc.size > 0) {
        await uploadToS3(s3, s3Key, doc.buffer, doc.contentType);
        const newDoc = await recordStateDocument({
          sourceId: source.id,
          url: docUrl,
          urlHash,
          filename,
          s3Key,
          sizeBytes: doc.size,
          mimeType: doc.contentType,
          status: 'uploaded',
          discoveredFrom: docInfo.foundOnPage,
          s3UploadedAt: new Date(),
          title: docInfo.linkText || undefined,
        });
        await bridgeStateDocToFileBlob(newDoc.id, { s3Key, filename, mimeType: doc.contentType, sizeBytes: doc.size, sourceSlug: source.slug, agency: source.agency });
        progress.documentsDownloaded++;
        summary.newDocuments++;
        if (downloadIndex % 10 === 0 || progress.documentsDownloaded <= 5) {
          addLog(progress, `OK [${downloadIndex}/${docsSeen.size}]: ${filename} (${Math.round(doc.size / 1024)}KB)`);
        }
      }
    } catch (e: any) {
      const failureType = classifyError(e);
      progress.documentsFailed++;
      summary.errors.push({ url: docUrl, error: e.message || 'Unknown error', failureType });
      if (summary.failuresByType) {
        summary.failuresByType[failureType] = (summary.failuresByType[failureType] || 0) + 1;
      }
      if (e.message?.includes('403') && summary.protectionStats) {
        summary.protectionStats.blockedDocuments++;
        summary.protectionStats.detected = true;
      }

      await recordStateDocument({
        sourceId: source.id,
        url: docUrl,
        urlHash,
        filename,
        status: 'failed',
        errorMessage: e.message,
        discoveredFrom: docInfo.foundOnPage,
      }).catch(() => {});

      if (downloadIndex % 10 === 0) {
        addLog(progress, `FAIL [${downloadIndex}/${docsSeen.size}]: ${filename} - ${e.message}`);
      }
    }

    if (downloadIndex % 5 === 0) {
      await updateStateRunProgress(run.id, progress);
    }

    const delay = 200 + Math.random() * 500;
    await new Promise(r => setTimeout(r, delay));
  }

  progress.completedAt = new Date();
  progress.currentUrl = '';

  const durationMs = progress.completedAt.getTime() - progress.startedAt.getTime();
  const durationSec = Math.round(durationMs / 1000);
  const durationStr = durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`;

  const attemptedDownloads = progress.documentsDownloaded + progress.documentsFailed;
  const downloadSuccessRate = attemptedDownloads > 0
    ? ((progress.documentsDownloaded / attemptedDownloads) * 100).toFixed(1)
    : 'N/A';

  const failureSummaryParts: string[] = [];
  if (summary.failuresByType) {
    for (const [type, count] of Object.entries(summary.failuresByType)) {
      failureSummaryParts.push(`${count}x ${type}`);
    }
  }
  const failureSummaryStr = failureSummaryParts.length > 0 ? failureSummaryParts.join(', ') : 'none';

  let finalStatus: 'completed' | 'completed_with_errors' | 'failed';
  let statusReason: string;

  const blockedPages = summary.protectionStats?.blockedPages || 0;
  const siteCompletelyBlocked = progress.pagesVisited <= 2 && blockedPages > 10;
  const highFailureRate = attemptedDownloads > 0 && (progress.documentsFailed / attemptedDownloads) > 0.5;
  const allNewFailed = attemptedDownloads > 0 && progress.documentsDownloaded === 0 && progress.documentsFailed > 0;

  if (siteCompletelyBlocked) {
    finalStatus = 'failed';
    statusReason = `Site completely blocked — only ${progress.pagesVisited} pages visited, ${blockedPages} pages blocked`;
  } else if (allNewFailed) {
    finalStatus = 'completed_with_errors';
    statusReason = `All ${progress.documentsFailed} new download attempts failed (${failureSummaryStr})`;
  } else if (highFailureRate && attemptedDownloads >= 5) {
    finalStatus = 'completed_with_errors';
    statusReason = `High failure rate: ${progress.documentsFailed} of ${attemptedDownloads} failed (${downloadSuccessRate}% success)`;
  } else {
    finalStatus = 'completed';
    if (progress.documentsDownloaded > 0) {
      statusReason = `${progress.documentsDownloaded} new docs uploaded, ${progress.duplicatesSkipped} duplicates`;
    } else if (progress.duplicatesSkipped > 0) {
      statusReason = `No new docs — all ${progress.duplicatesSkipped} discovered docs already in database`;
    } else {
      statusReason = `No documents discovered on this site`;
    }
  }

  progress.status = finalStatus === 'completed_with_errors' ? 'completed_with_errors' : finalStatus;

  addLog(progress, `=== STATE CRAWL SUMMARY ===`);
  addLog(progress, `SOURCE: ${source.name} (${source.agency})`);
  addLog(progress, `STATUS: ${finalStatus} — ${statusReason}`);
  addLog(progress, `DURATION: ${durationStr}`);
  addLog(progress, `PAGES: ${progress.pagesVisited} visited`);
  addLog(progress, `DISCOVERY: ${progress.documentsDiscovered} docs found — Sitemap=${stats.sitemap}, KnownPaths=${stats.knownPaths}, BFS=${stats.breadthFirst}, Iframe=${stats.iframe}`);
  addLog(progress, `DUPLICATES: ${progress.duplicatesSkipped} already in database`);
  addLog(progress, `DOWNLOADS: ${progress.documentsDownloaded} succeeded, ${progress.documentsFailed} failed (${downloadSuccessRate}% success rate)`);
  if (hasLinkFilter) addLog(progress, `LINK FILTER: ${linkFilterSkipped} docs skipped by text filter`);
  if (excludePatterns.length > 0) addLog(progress, `EXCLUDE FILTER: ${excludeFilterSkipped} URLs skipped`);
  addLog(progress, `REQUESTS: Fast Lane=${fastLaneRequests}, Heavy Lane=${heavyLaneRequests}`);
  addLog(progress, `=== END STATE CRAWL SUMMARY ===`);

  (summary as any).strategyStats = stats;
  (summary as any).statusReason = statusReason;
  (summary as any).fastLaneRequests = fastLaneRequests;
  (summary as any).heavyLaneRequests = heavyLaneRequests;
  (summary as any).linkFilterSkipped = linkFilterSkipped;
  (summary as any).excludeFilterSkipped = excludeFilterSkipped;

  const errorMessageForDb = finalStatus === 'completed' ? null : statusReason;

  await completeStateSourceRun(run.id, finalStatus, {
    pagesVisited: progress.pagesVisited,
    documentsDiscovered: progress.documentsDiscovered,
    documentsDownloaded: progress.documentsDownloaded,
    documentsUploaded: progress.documentsDownloaded,
    documentsFailed: progress.documentsFailed,
    errorMessage: errorMessageForDb || undefined,
    summary,
  });

  await db.update(crawlerStateSources)
    .set({
      lastCrawlDate: new Date(),
      totalDocuments: sql`(SELECT COUNT(*) FROM crawler_state_documents WHERE source_id = ${source.id})`,
      totalUploaded: sql`(SELECT COUNT(*) FROM crawler_state_documents WHERE source_id = ${source.id} AND status = 'uploaded')`,
      consecutiveFailures: finalStatus === 'failed' ? sql`consecutive_failures + 1` : 0,
      updatedAt: new Date(),
    })
    .where(eq(crawlerStateSources.id, source.id));

  setTimeout(() => {
    activeCrawls.delete(run.id);
  }, 300000);
}

