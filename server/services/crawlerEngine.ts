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

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
}

interface FoundDocument {
  url: string;
  linkText: string;
  foundOnPage: string;
}

interface CrawlJob {
  progress: CrawlProgress;
  abortController: AbortController;
}

function isDocumentUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
  if (docExts.some(ext => lower.endsWith(ext) || lower.includes(ext + '?'))) return true;
  if (lower.includes('/viewfile/')) return true;
  if (lower.includes('/agendacenter/viewfile/')) return true;
  if (lower.includes('/documentcenter/view/')) return true;
  if (lower.includes('/wp-content/uploads/') && docExts.some(ext => lower.includes(ext))) return true;
  return false;
}

function isRelevantNavLink(url: string, linkText: string): boolean {
  const combined = (url + ' ' + linkText).toLowerCase();
  return /minute|meeting|agenda|board|committee|select|planning|zoning|conservation|document|archive|report|budget|ordinance|warrant|annual|form|regulation|policy/i.test(combined);
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
    return new URL(url).hostname === new URL(baseUrl).hostname;
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

async function fetchPage(url: string, signal: AbortSignal): Promise<{ html: string; status: number } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal,
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) return null;
    const html = await response.text();
    return { html, status: response.status };
  } catch {
    return null;
  }
}

async function fetchDocument(url: string, signal: AbortSignal): Promise<{ buffer: Buffer; contentType: string; size: number } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*',
        'Referer': new URL(url).origin,
      },
      signal,
      redirect: 'follow',
    });
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
    throw e;
  }
}

function addLog(progress: CrawlProgress, message: string) {
  const timestamp = new Date().toISOString().substring(11, 19);
  progress.log.push(`[${timestamp}] ${message}`);
  if (progress.log.length > 500) {
    progress.log = progress.log.slice(-400);
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
  const maxPages = options.maxPages || town.maxPages || 150;
  const baseUrl = town.url;

  const s3 = new S3Client({ region: S3_REGION });

  addLog(progress, `Starting crawl of ${town.name} (${baseUrl})`);
  addLog(progress, `Max pages: ${maxPages}`);

  const visited = new Set<string>();
  const docsSeen = new Set<string>();
  const queue: Array<{ url: string; depth: number; priority: number }> = [];

  const summary: CrawlRunSummary = {
    byCategory: {},
    byBoard: {},
    newDocuments: 0,
    duplicates: 0,
    errors: [],
    failuresByType: {} as Record<FailureType, number>,
    pagesVisited: 0,
    documentsDiscovered: 0,
  };

  const startPaths = [
    '/',
    '/boards',
    '/government',
    '/minutes',
    '/meetings',
    '/selectmen',
    '/selectboard',
    '/board-of-selectmen',
    '/planning-board',
    '/zoning-board',
    '/conservation',
    '/documents',
    '/archives',
    '/agendas-minutes',
    '/town-departments',
    '/town-offices',
    ...(town.customPaths || []),
  ];

  for (const p of startPaths) {
    const fullUrl = p.startsWith('http') ? p : baseUrl.replace(/\/$/, '') + p;
    queue.push({ url: fullUrl, depth: 0, priority: p === '/' ? 0 : 1 });
  }

  let sitemapDocs = 0;
  try {
    const sitemapUrl = baseUrl.replace(/\/$/, '') + '/sitemap.xml';
    addLog(progress, `Checking sitemap: ${sitemapUrl}`);
    const sitemapResp = await fetch(sitemapUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal,
    });
    if (sitemapResp.ok) {
      const xml = await sitemapResp.text();
      const urlMatches = xml.matchAll(/<loc>(.*?)<\/loc>/gi);
      for (const m of urlMatches) {
        const u = m[1].trim();
        if (isDocumentUrl(u)) {
          if (!docsSeen.has(u)) {
            docsSeen.add(u);
            sitemapDocs++;
          }
        } else if (isSameDomain(u, baseUrl)) {
          queue.push({ url: u, depth: 1, priority: 2 });
        }
      }
      addLog(progress, `Sitemap: found ${sitemapDocs} document URLs`);
    } else {
      addLog(progress, `No sitemap found (${sitemapResp.status})`);
    }
  } catch {
    addLog(progress, 'Sitemap fetch failed, continuing with crawl');
  }

  progress.pagesQueued = queue.length;
  let progressUpdateCounter = 0;

  while (queue.length > 0 && progress.pagesVisited < maxPages) {
    if (signal.aborted) {
      addLog(progress, 'Crawl aborted by user');
      break;
    }

    queue.sort((a, b) => a.priority - b.priority || a.depth - b.depth);
    const { url: pageUrl, depth } = queue.shift()!;

    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    if (!isSameDomain(pageUrl, baseUrl)) continue;

    progress.currentUrl = pageUrl;
    progress.pagesQueued = queue.length;

    const page = await fetchPage(pageUrl, signal);
    if (!page) {
      continue;
    }

    progress.pagesVisited++;
    summary.pagesVisited = progress.pagesVisited;

    const links = extractLinksFromHtml(page.html, pageUrl);

    let pageDocsFound = 0;
    for (const link of links) {
      if (isDocumentUrl(link.href) && !docsSeen.has(link.href)) {
        docsSeen.add(link.href);
        pageDocsFound++;
        progress.documentsDiscovered++;
        summary.documentsDiscovered = progress.documentsDiscovered;

        const urlHash = hashUrl(link.href);
        const filename = extractFilename(link.href);
        const metadata = extractDocumentMetadata(link.href, filename, pageUrl);
        const s3Key = generateS3Key({
          town: town.slug,
          url: link.href,
          filename,
          discoveredFrom: pageUrl,
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
              url: link.href,
              urlHash,
              filename,
              category: metadata.category,
              board: metadata.board,
              year: metadata.year,
              s3Key,
              status: 'uploaded',
              discoveredFrom: pageUrl,
              s3UploadedAt: new Date(),
            });
            progress.duplicatesSkipped++;
            summary.duplicates++;
            addLog(progress, `SKIP (S3 exists): ${filename}`);
            continue;
          }

          const doc = await fetchDocument(link.href, signal);
          if (doc) {
            await uploadToS3(s3, s3Key, doc.buffer, doc.contentType);
            await recordDocument({
              townId: town.id,
              url: link.href,
              urlHash,
              filename,
              category: metadata.category,
              board: metadata.board,
              year: metadata.year,
              s3Key,
              sizeBytes: doc.size,
              mimeType: doc.contentType,
              status: 'uploaded',
              discoveredFrom: pageUrl,
              s3UploadedAt: new Date(),
            });
            progress.documentsDownloaded++;
            summary.newDocuments++;
            addLog(progress, `OK: ${filename} (${Math.round(doc.size / 1024)}KB) -> ${s3Key}`);
          }
        } catch (e: any) {
          const failureType = classifyError(e);
          progress.documentsFailed++;
          summary.errors.push({
            url: link.href,
            error: e.message || 'Unknown error',
            failureType,
          });
          if (summary.failuresByType) {
            summary.failuresByType[failureType] = (summary.failuresByType[failureType] || 0) + 1;
          }

          await recordDocument({
            townId: town.id,
            url: link.href,
            urlHash,
            filename,
            category: metadata.category,
            board: metadata.board,
            year: metadata.year,
            status: 'failed',
            errorMessage: e.message,
            discoveredFrom: pageUrl,
          });

          addLog(progress, `FAIL: ${filename} - ${e.message}`);
        }
      }

      if (depth < 3 && !visited.has(link.href) && isSameDomain(link.href, baseUrl) && !isDocumentUrl(link.href)) {
        if (isRelevantNavLink(link.href, link.text)) {
          queue.push({ url: link.href, depth: depth + 1, priority: depth + 2 });
        }
      }
    }

    if (pageDocsFound > 0) {
      addLog(progress, `Page ${progress.pagesVisited}: ${pageDocsFound} docs found on ${pageUrl.substring(baseUrl.length)}`);
    }

    progressUpdateCounter++;
    if (progressUpdateCounter % 5 === 0) {
      await updateRunProgress(run.id, progress);
    }

    const delay = 500 + Math.random() * 1000;
    await new Promise(r => setTimeout(r, delay));
  }

  progress.status = 'completed';
  progress.completedAt = new Date();
  progress.currentUrl = '';

  addLog(progress, `Crawl complete. Pages: ${progress.pagesVisited}, Docs found: ${progress.documentsDiscovered}, Downloaded: ${progress.documentsDownloaded}, Failed: ${progress.documentsFailed}, Duplicates: ${progress.duplicatesSkipped}`);

  const finalStatus = progress.documentsFailed > 0 && progress.documentsDownloaded === 0 ? 'failed' : 'completed';

  await db.update(crawlerRuns)
    .set({
      status: finalStatus,
      completedAt: new Date(),
      pagesVisited: progress.pagesVisited,
      documentsDiscovered: progress.documentsDiscovered,
      documentsUploaded: progress.documentsDownloaded,
      documentsFailed: progress.documentsFailed,
      summary,
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
