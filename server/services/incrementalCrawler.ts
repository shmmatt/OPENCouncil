import {
  fetchPage,
  fetchHomepage,
  extractLinksFromHtml,
  isDocumentUrl,
  detectCmsFromHtml,
  detectProtection,
  getCivicPlusPaginationUrls,
  probeWordPressMediaApi,
  crawlDriveFolderHtml,
  type CmsType,
  type FetchPageResult,
} from './crawlerEngine';
import {
  hashUrl,
  diffSitemap,
  hashSitemap,
  saveSitemap,
  getLatestSitemap,
  getAllTownDocumentUrls,
  batchRecordDocuments,
  createRun,
  completeRun,
  updateTownStats,
  getTownById,
  resetFailureCount,
  incrementFailureCount,
} from './crawlerState';
import { extractFilename, extractDocumentMetadata } from './crawlerStateExtensions';
import { isScrapingApiConfigured, fetchPageViaAPI } from './scrapingApiClient';
import { parseDriveFolderUrl } from './googleDriveClient';
import { crawlerRuns, type InsertCrawlerDocument, type SitemapUrl } from '../../shared/crawler-schema';
import { db } from '../storage/db';
import { eq } from 'drizzle-orm';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

export interface IncrementalCrawlResult {
  townSlug: string;
  townId: string;
  sitemapChanged: boolean;
  newDocsFound: number;
  updatedDocsFound: number;
  skippedExisting: number;
  strategyBreakdown: {
    sitemap: number;
    cmsProbe: number;
    wordpress: number;
    googleDrive: number;
  };
  headRequestsMade: number;
  pagesVisited: number;
  durationMs: number;
  error?: string;
}

interface KnownDoc {
  status: string;
  updatedAt: Date;
  url: string;
}

const MAX_HEAD_REQUESTS_PER_CRAWL = 20;
const MAX_PAGINATION_DEPTH = 5;
const PAGE_DELAY_MS = 200;

async function fetchPageWithHeavyLane(
  url: string,
  signal: AbortSignal,
  useHeavyLane: boolean,
): Promise<FetchPageResult | null> {
  if (useHeavyLane && isScrapingApiConfigured()) {
    const apiResult = await fetchPageViaAPI(url);
    if (apiResult && apiResult.html.length > 100 && apiResult.status === 200) {
      return { html: apiResult.html, status: apiResult.status, headers: apiResult.headers, finalUrl: apiResult.finalUrl };
    }
  }
  return fetchPage(url, signal, 15000);
}

async function httpHead(url: string): Promise<{ lastModified?: string; contentLength?: string } | null> {
  try {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': ua },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    return {
      lastModified: response.headers.get('last-modified') || undefined,
      contentLength: response.headers.get('content-length') || undefined,
    };
  } catch {
    return null;
  }
}

function hasFileChanged(headResult: { lastModified?: string; contentLength?: string; etag?: string }, knownDoc: KnownDoc): boolean {
  if (headResult.lastModified) {
    const serverDate = new Date(headResult.lastModified);
    if (!isNaN(serverDate.getTime()) && serverDate > knownDoc.updatedAt) {
      return true;
    }
  }
  return false;
}

async function parseSitemapXml(url: string, signal: AbortSignal): Promise<{ xml: string; urls: SitemapUrl[] } | null> {
  try {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    const response = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept': 'application/xml,text/xml,*/*' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const xml = await response.text();
    if (!xml.includes('<urlset') && !xml.includes('<sitemapindex')) return null;

    const urls: SitemapUrl[] = [];

    if (xml.includes('<sitemapindex')) {
      const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
      let match;
      while ((match = locRegex.exec(xml)) !== null) {
        const childUrl = match[1].trim();
        if (childUrl.endsWith('.xml') || childUrl.includes('sitemap')) {
          try {
            const childResp = await fetch(childUrl, {
              headers: { 'User-Agent': ua, 'Accept': 'application/xml,text/xml,*/*' },
              signal: controller.signal,
            });
            if (childResp.ok) {
              const childXml = await childResp.text();
              const childLocRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
              let childMatch;
              while ((childMatch = childLocRegex.exec(childXml)) !== null) {
                const loc = childMatch[1].trim();
                urls.push({
                  url: loc,
                  priority: 'medium',
                  discovered: new Date().toISOString(),
                  docCount: 0,
                });
              }
            }
          } catch {}
        }
      }
    } else {
      const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
      let match;
      while ((match = locRegex.exec(xml)) !== null) {
        const loc = match[1].trim();
        urls.push({
          url: loc,
          priority: 'medium',
          discovered: new Date().toISOString(),
          docCount: 0,
        });
      }
    }

    return { xml, urls };
  } catch {
    return null;
  }
}

function buildDocRecord(
  townId: string,
  docUrl: string,
  discoveredFrom: string,
): InsertCrawlerDocument {
  const urlHash = hashUrl(docUrl);
  const filename = extractFilename(docUrl);
  const meta = extractDocumentMetadata(docUrl, filename);
  return {
    townId,
    url: docUrl,
    urlHash,
    filename,
    category: meta.category,
    board: meta.board,
    year: meta.year,
    discoveredFrom,
    status: 'discovered',
  };
}

async function probeRecentPages(
  baseUrl: string,
  paths: string[],
  townId: string,
  knownHashes: Map<string, KnownDoc>,
  signal: AbortSignal,
  useHeavyLane: boolean,
  cms: CmsType,
  stats: IncrementalCrawlResult,
): Promise<InsertCrawlerDocument[]> {
  const newDocs: InsertCrawlerDocument[] = [];
  const seenUrls = new Set<string>();
  let headRequestsRemaining = MAX_HEAD_REQUESTS_PER_CRAWL - stats.headRequestsMade;

  for (const path of paths) {
    if (signal.aborted) break;
    const fullUrl = path.startsWith('http') ? path : `${baseUrl}${path}`;

    let pagesToCheck: string[] = [fullUrl];
    let page = 0;

    while (pagesToCheck.length > 0 && page < MAX_PAGINATION_DEPTH) {
      if (signal.aborted) break;
      const currentUrl = pagesToCheck.shift()!;
      page++;

      const resp = await fetchPageWithHeavyLane(currentUrl, signal, useHeavyLane);
      if (!resp || resp.status !== 200 || resp.html.length < 200) break;

      stats.pagesVisited++;
      const links = extractLinksFromHtml(resp.html, currentUrl);
      let allKnownOnPage = true;
      let docsFoundOnPage = 0;

      for (const link of links) {
        if (!isDocumentUrl(link.href) || seenUrls.has(link.href)) continue;
        seenUrls.add(link.href);

        const urlHash = hashUrl(link.href);
        const known = knownHashes.get(urlHash);

        if (!known) {
          allKnownOnPage = false;
          docsFoundOnPage++;
          newDocs.push(buildDocRecord(townId, link.href, currentUrl));
          stats.newDocsFound++;
          stats.strategyBreakdown.cmsProbe++;
        } else {
          stats.skippedExisting++;
          if (page <= 2 && headRequestsRemaining > 0 && known.status === 'uploaded') {
            const headResult = await httpHead(link.href);
            stats.headRequestsMade++;
            headRequestsRemaining--;
            if (headResult && hasFileChanged(headResult, known)) {
              newDocs.push({
                ...buildDocRecord(townId, link.href, currentUrl),
                status: 'discovered',
              });
              stats.updatedDocsFound++;
            }
          }
        }
      }

      if (allKnownOnPage && docsFoundOnPage === 0 && page > 1) {
        break;
      }

      if (cms === 'CivicPlus') {
        const paginationUrls = getCivicPlusPaginationUrls(resp.html, currentUrl);
        for (const pu of paginationUrls) {
          if (!pagesToCheck.includes(pu)) {
            pagesToCheck.push(pu);
          }
        }
      }

      await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
    }
  }

  return newDocs;
}

export async function incrementalCrawl(
  townId: string,
  triggerType: 'scheduled' | 'manual' = 'manual',
): Promise<IncrementalCrawlResult> {
  const startTime = Date.now();
  const town = await getTownById(townId);
  if (!town) {
    throw new Error(`Town not found: ${townId}`);
  }

  const result: IncrementalCrawlResult = {
    townSlug: town.slug,
    townId: town.id,
    sitemapChanged: false,
    newDocsFound: 0,
    updatedDocsFound: 0,
    skippedExisting: 0,
    strategyBreakdown: { sitemap: 0, cmsProbe: 0, wordpress: 0, googleDrive: 0 },
    headRequestsMade: 0,
    pagesVisited: 0,
    durationMs: 0,
  };

  const run = await createRun({
    townId: town.id,
    mode: 'incremental',
    triggerType,
    status: 'running',
    pagesVisited: 0,
    documentsDiscovered: 0,
    documentsDownloaded: 0,
    documentsUploaded: 0,
    documentsFailed: 0,
    resumedFromCheckpoint: false,
  });

  const abortController = new AbortController();
  const signal = abortController.signal;
  const timeout = setTimeout(() => abortController.abort(), 5 * 60 * 1000);

  try {
    console.log(`[IncrementalCrawl] Starting for ${town.name} (${town.slug})`);

    const existingDocs = await getAllTownDocumentUrls(town.id);
    const knownHashes = new Map<string, KnownDoc>();
    for (const doc of existingDocs) {
      knownHashes.set(doc.urlHash, {
        status: doc.status,
        updatedAt: doc.s3UploadedAt || doc.updatedAt || new Date(0),
        url: doc.url,
      });
    }
    console.log(`[IncrementalCrawl] Loaded ${knownHashes.size} known document hashes`);

    const allNewDocs: InsertCrawlerDocument[] = [];

    const homepage = await fetchHomepage(town.url, signal);
    const useHeavyLane = !!(homepage as any)?.needsHeavyLane || !!(homepage as any)?.viaHeavyLane;
    const detectedCms = homepage && homepage.html ? detectCmsFromHtml(homepage.html, town.url) : (town.cms as CmsType || 'Custom');
    result.pagesVisited++;

    console.log(`[IncrementalCrawl] CMS: ${detectedCms}, Heavy Lane: ${useHeavyLane}`);

    const sitemapUrl = `${town.url}/sitemap.xml`;
    const sitemapData = await parseSitemapXml(sitemapUrl, signal);
    if (sitemapData && sitemapData.urls.length > 0) {
      const currentHash = hashSitemap(sitemapData.xml);
      const diff = await diffSitemap(town.id, sitemapData.urls, currentHash);

      result.sitemapChanged = diff.isChanged;

      if (diff.isChanged) {
        console.log(`[IncrementalCrawl] Sitemap changed: ${diff.newUrls.length} new URLs`);
        for (const sUrl of diff.newUrls) {
          if (isDocumentUrl(sUrl.url)) {
            const urlHash = hashUrl(sUrl.url);
            if (!knownHashes.has(urlHash)) {
              allNewDocs.push(buildDocRecord(town.id, sUrl.url, sitemapUrl));
              result.strategyBreakdown.sitemap++;
              result.newDocsFound++;
            }
          }
        }

        await saveSitemap({
          townId: town.id,
          sitemapUrl,
          hash: currentHash,
          urlCount: sitemapData.urls.length,
          urls: sitemapData.urls,
        });
      } else {
        console.log(`[IncrementalCrawl] Sitemap unchanged`);
      }
    }

    if (detectedCms === 'CivicPlus') {
      console.log(`[IncrementalCrawl] Probing CivicPlus recent pages...`);
      const civicPaths = [
        '/AgendaCenter',
        '/DocumentCenter',
      ];
      const civicDocs = await probeRecentPages(
        town.url, civicPaths, town.id, knownHashes, signal, useHeavyLane, detectedCms, result,
      );
      allNewDocs.push(...civicDocs);
    } else if (detectedCms === 'WordPress') {
      console.log(`[IncrementalCrawl] Querying WordPress Media API...`);
      const wpDocs = await probeWordPressMediaApi(town.url, signal);
      for (const wpUrl of wpDocs) {
        const urlHash = hashUrl(wpUrl);
        if (!knownHashes.has(urlHash)) {
          allNewDocs.push(buildDocRecord(town.id, wpUrl, `${town.url}/wp-json/wp/v2/media`));
          result.strategyBreakdown.wordpress++;
          result.newDocsFound++;
        }
      }
    }

    const genericPaths = ['/minutes', '/agendas', '/meetings', '/documents'];
    if (detectedCms !== 'CivicPlus') {
      console.log(`[IncrementalCrawl] Probing generic recent pages...`);
      const genericDocs = await probeRecentPages(
        town.url, genericPaths, town.id, knownHashes, signal, useHeavyLane, detectedCms, result,
      );
      allNewDocs.push(...genericDocs);
    }

    if (town.driveFolderId) {
      console.log(`[IncrementalCrawl] Checking Google Drive folder...`);
      const driveFiles = await crawlDriveFolderHtml(town.driveFolderId, signal, 0, 2);
      for (const df of driveFiles) {
        const driveUrl = `https://drive.google.com/file/d/${df.fileId}/view`;
        const urlHash = hashUrl(driveUrl);
        if (!knownHashes.has(urlHash)) {
          allNewDocs.push(buildDocRecord(town.id, driveUrl, `drive:${town.driveFolderId}`));
          result.strategyBreakdown.googleDrive++;
          result.newDocsFound++;
        }
      }
    }

    const uniqueDocs = new Map<string, InsertCrawlerDocument>();
    for (const doc of allNewDocs) {
      if (!uniqueDocs.has(doc.urlHash)) {
        uniqueDocs.set(doc.urlHash, doc);
      }
    }
    const finalDocs = Array.from(uniqueDocs.values());

    if (finalDocs.length > 0) {
      console.log(`[IncrementalCrawl] Recording ${finalDocs.length} new/updated documents`);
      await batchRecordDocuments(finalDocs);
    }

    result.newDocsFound = finalDocs.filter(d => !knownHashes.has(d.urlHash)).length;
    result.durationMs = Date.now() - startTime;

    const jitterHours = Math.random() * 6;
    const nextCrawl = new Date(Date.now() + (7 * 24 * 60 * 60 * 1000) + (jitterHours * 60 * 60 * 1000));

    await updateTownStats(town.id, {
      lastIncrementalCrawl: new Date(),
      lastCrawlDocsFound: finalDocs.length,
    });

    await completeRun(run.id, 'completed', {
      documentsDiscovered: finalDocs.length,
      documentsUpdated: result.updatedDocsFound,
      sitemapChanged: result.sitemapChanged,
      strategyBreakdown: result.strategyBreakdown,
      headRequestsMade: result.headRequestsMade,
      pagesVisited: result.pagesVisited,
      durationMs: result.durationMs,
    } as any);

    await db.update(crawlerRuns)
      .set({
        documentsDiscovered: finalDocs.length,
        pagesVisited: result.pagesVisited,
      })
      .where(eq(crawlerRuns.id, run.id));

    await resetFailureCount(town.id);

    console.log(`[IncrementalCrawl] Complete for ${town.name}: ${finalDocs.length} new docs, ${result.updatedDocsFound} updated, ${result.skippedExisting} skipped (${result.durationMs}ms)`);

    return result;

  } catch (error: any) {
    result.durationMs = Date.now() - startTime;
    result.error = error.message;

    await completeRun(run.id, 'failed', undefined, error.message);
    await incrementFailureCount(town.id);

    console.error(`[IncrementalCrawl] Failed for ${town.name}: ${error.message}`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
