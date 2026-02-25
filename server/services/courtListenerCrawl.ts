import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { db } from '../storage/db';
import * as schema from '../../shared/schema';
import { crawlerStateSources, crawlerStateDocuments } from '../../shared/crawler-schema';
import type { CrawlerStateSource, CrawlerStateSourceRun, InsertCrawlerStateDocument } from '../../shared/crawler-schema';
import { eq, sql } from 'drizzle-orm';
import { hashUrl, recordStateDocument, getAllStateDocumentUrls, updateStateRunProgress } from './crawlerState';
import { completeStateSourceRun } from '../storage/crawler';
import {
  activeCrawls,
  addLog,
  generateStateS3Key,
  bridgeStateDocToFileBlob,
  type CrawlProgress,
  type CrawlJob,
} from './crawlerEngine';
import {
  isCourtListenerConfigured,
  fetchClusters,
  fetchClusterPage,
  fetchOpinion,
  extractOpinionText,
  buildClusterUrl,
  buildOpinionFilename,
  type CLCluster,
  type CLPaginatedResponse,
} from './courtListenerClient';

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';

function matchesMunicipalFilter(caseName: string, linkPatterns: string[]): boolean {
  if (linkPatterns.length === 0) return true;
  const lower = caseName.toLowerCase();
  for (const pattern of linkPatterns) {
    if (lower.includes(pattern.toLowerCase())) return true;
  }
  return false;
}

function matchesExcludeFilter(caseName: string, excludePatterns: string[]): boolean {
  if (excludePatterns.length === 0) return false;
  const lower = caseName.toLowerCase();
  for (const pattern of excludePatterns) {
    if (lower.includes(pattern.toLowerCase())) return true;
  }
  return false;
}

export async function startCourtListenerCrawl(
  source: CrawlerStateSource,
  run: CrawlerStateSourceRun,
  options: { dateFiledAfter?: string } = {}
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

  executeCourtListenerCrawl(source, run, job, options).catch(async (err) => {
    progress.status = 'failed';
    progress.errorMessage = err.message;
    addLog(progress, `FATAL: Unhandled exception — ${err.message}`);

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

async function executeCourtListenerCrawl(
  source: CrawlerStateSource,
  run: CrawlerStateSourceRun,
  job: CrawlJob,
  options: { dateFiledAfter?: string }
) {
  const { progress, abortController } = job;
  const signal = abortController.signal;
  const s3 = new S3Client({ region: S3_REGION });

  const linkPatterns = (source.linkPatterns as string[]) || [];
  const excludePatterns = (source.excludePatterns as string[]) || [];
  const hasLinkFilter = linkPatterns.length > 0;

  let apiPagesProcessed = 0;
  let clustersScanned = 0;
  let municipalMatches = 0;
  let excludeFiltered = 0;
  let linkFilterSkipped = 0;
  let opinionsStored = 0;
  let duplicatesFound = 0;
  let opinionsFailed = 0;

  const startTime = Date.now();

  addLog(progress, '=== COURTLISTENER API CRAWL ===');
  addLog(progress, `Source: ${source.name} (${source.agency})`);

  if (!isCourtListenerConfigured()) {
    addLog(progress, 'FATAL: COURTLISTENER_API_TOKEN not configured');
    progress.status = 'failed';
    progress.errorMessage = 'COURTLISTENER_API_TOKEN not configured';
    await completeStateSourceRun(run.id, 'failed', {
      pagesVisited: 0,
      documentsDiscovered: 0,
      documentsDownloaded: 0,
      documentsUploaded: 0,
      documentsFailed: 0,
      errorMessage: 'COURTLISTENER_API_TOKEN not configured',
    });
    return;
  }

  const dateFiledAfter = options.dateFiledAfter
    || (source.lastCrawlDate ? source.lastCrawlDate.toISOString().split('T')[0] : undefined);

  if (dateFiledAfter) {
    addLog(progress, `Incremental mode: fetching opinions filed after ${dateFiledAfter}`);
  } else {
    addLog(progress, 'Full mode: fetching all NH Supreme Court opinions');
  }

  if (hasLinkFilter) {
    addLog(progress, `Municipal filter: ${linkPatterns.join(', ')}`);
  }
  if (excludePatterns.length > 0) {
    addLog(progress, `Exclude filter: ${excludePatterns.join(', ')}`);
  }

  const existingUrlRows = await getAllStateDocumentUrls(source.id);
  const existingUrls = new Set(existingUrlRows.map(r => r.url));
  addLog(progress, `Pre-existing documents in DB: ${existingUrls.size}`);

  addLog(progress, '--- Phase 1: Fetch Clusters from CourtListener API ---');

  let currentPage: CLPaginatedResponse<CLCluster> | null = await fetchClusters({
    courtId: 'nh',
    dateFiledAfter,
    pageSize: 20,
    orderBy: '-date_filed',
  }, signal);

  if (!currentPage || !currentPage.results) {
    addLog(progress, 'ERROR: Failed to fetch initial cluster page from CourtListener');
    progress.status = 'failed';
    progress.errorMessage = 'Failed to fetch clusters from CourtListener API';
    await completeStateSourceRun(run.id, 'failed', {
      pagesVisited: 0,
      documentsDiscovered: 0,
      documentsDownloaded: 0,
      documentsUploaded: 0,
      documentsFailed: 0,
      errorMessage: 'CourtListener API returned no data',
    });
    return;
  }

  const totalCount = typeof currentPage.count === 'number'
    ? currentPage.count
    : parseInt(String(currentPage.count), 10) || 0;
  addLog(progress, `Total NH Supreme Court clusters: ${totalCount}`);
  progress.pagesQueued = Math.ceil(totalCount / 20);

  const matchedClusters: CLCluster[] = [];

  while (currentPage && currentPage.results.length > 0) {
    if (signal.aborted) {
      addLog(progress, 'Crawl aborted by admin');
      break;
    }

    apiPagesProcessed++;
    progress.pagesVisited = apiPagesProcessed;

    for (const cluster of currentPage.results) {
      clustersScanned++;
      const caseName = cluster.case_name || cluster.case_name_full || '';

      if (matchesExcludeFilter(caseName, excludePatterns)) {
        excludeFiltered++;
        continue;
      }

      if (hasLinkFilter && !matchesMunicipalFilter(caseName, linkPatterns)) {
        linkFilterSkipped++;
        continue;
      }

      const clUrl = buildClusterUrl(cluster);

      if (existingUrls.has(clUrl)) {
        duplicatesFound++;
        progress.duplicatesSkipped++;
        continue;
      }

      matchedClusters.push(cluster);
      municipalMatches++;
      progress.documentsDiscovered++;
    }

    progress.currentUrl = `API page ${apiPagesProcessed} — ${clustersScanned} scanned, ${municipalMatches} matched`;

    if (apiPagesProcessed % 10 === 0) {
      addLog(progress, `Page ${apiPagesProcessed}: ${clustersScanned} clusters scanned, ${municipalMatches} municipal matches, ${excludeFiltered} excluded, ${linkFilterSkipped} filtered`);
      await updateStateRunProgress(run.id, {
        pagesVisited: apiPagesProcessed,
        documentsDiscovered: progress.documentsDiscovered,
      });
    }

    if (!currentPage.next) break;

    currentPage = await fetchClusterPage(currentPage.next, signal);
  }

  addLog(progress, `--- Phase 1 Complete ---`);
  addLog(progress, `Clusters scanned: ${clustersScanned}`);
  addLog(progress, `Municipal matches: ${municipalMatches}`);
  addLog(progress, `Exclude filtered: ${excludeFiltered}`);
  addLog(progress, `Link filter skipped: ${linkFilterSkipped}`);
  addLog(progress, `Duplicates (already in DB): ${duplicatesFound}`);

  if (signal.aborted) {
    await completeStateSourceRun(run.id, 'failed', {
      pagesVisited: apiPagesProcessed,
      documentsDiscovered: progress.documentsDiscovered,
      documentsDownloaded: progress.documentsDownloaded,
      documentsUploaded: progress.documentsDownloaded,
      documentsFailed: progress.documentsFailed,
      errorMessage: 'Aborted by admin',
    });
    return;
  }

  addLog(progress, `--- Phase 2: Fetch & Store ${matchedClusters.length} Opinion Texts ---`);

  for (let i = 0; i < matchedClusters.length; i++) {
    if (signal.aborted) {
      addLog(progress, 'Crawl aborted during opinion fetching');
      break;
    }

    const cluster = matchedClusters[i];
    const caseName = cluster.case_name || cluster.case_name_full || 'Unknown Case';
    const clUrl = buildClusterUrl(cluster);
    const filename = buildOpinionFilename(cluster);
    const urlH = hashUrl(clUrl);

    progress.currentUrl = `[${i + 1}/${matchedClusters.length}] ${caseName}`;

    if (cluster.sub_opinions.length === 0) {
      addLog(progress, `SKIP: ${caseName} — no sub-opinions available`);
      opinionsFailed++;
      progress.documentsFailed++;
      continue;
    }

    try {
      const opinionUrl = cluster.sub_opinions[0];
      const opinion = await fetchOpinion(opinionUrl, signal);

      if (!opinion) {
        addLog(progress, `FAIL: Could not fetch opinion for ${caseName}`);
        opinionsFailed++;
        progress.documentsFailed++;

        await recordStateDocument({
          sourceId: source.id,
          url: clUrl,
          urlHash: urlH,
          filename,
          category: 'opinions',
          title: caseName,
          status: 'failed',
          errorMessage: 'CourtListener API returned no data for opinion',
          discoveredFrom: 'courtlistener-api',
        });
        continue;
      }

      let opinionText = extractOpinionText(opinion);

      if (!opinionText || opinionText.length < 100) {
        addLog(progress, `SKIP: ${caseName} — opinion text too short (${opinionText?.length || 0} chars)`);
        opinionsFailed++;
        progress.documentsFailed++;
        continue;
      }

      const header = [
        `Case: ${caseName}`,
        `Date Filed: ${cluster.date_filed}`,
        `Court: NH Supreme Court`,
        `CourtListener URL: ${clUrl}`,
        cluster.judges ? `Judges: ${cluster.judges}` : null,
        cluster.attorneys ? `Attorneys: ${cluster.attorneys}` : null,
        `Citation Count: ${cluster.citation_count}`,
        `Precedential Status: ${cluster.precedential_status}`,
        '',
        '---',
        '',
      ].filter(Boolean).join('\n');

      const fullText = header + opinionText;
      const textBuffer = Buffer.from(fullText, 'utf-8');
      const s3Key = `state/${source.slug}/opinions/${filename}`;

      let alreadyInS3 = false;
      try {
        await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
        alreadyInS3 = true;
      } catch {}

      if (!alreadyInS3) {
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: textBuffer,
          ContentType: 'text/plain; charset=utf-8',
        }));
      }

      const stateDoc = await recordStateDocument({
        sourceId: source.id,
        url: clUrl,
        urlHash: urlH,
        filename,
        category: 'opinions',
        title: caseName,
        status: 'uploaded',
        s3Key,
        sizeBytes: textBuffer.length,
        mimeType: 'text/plain',
        s3UploadedAt: new Date(),
        discoveredFrom: 'courtlistener-api',
      });

      await bridgeStateDocToFileBlob(stateDoc.id, {
        s3Key,
        filename,
        mimeType: 'text/plain',
        sizeBytes: textBuffer.length,
        sourceSlug: source.slug,
        agency: source.agency,
      });

      opinionsStored++;
      progress.documentsDownloaded++;

      if (opinionsStored % 10 === 0) {
        addLog(progress, `Stored ${opinionsStored}/${matchedClusters.length} opinions — latest: ${caseName} (${cluster.date_filed})`);
        await updateStateRunProgress(run.id, {
          pagesVisited: apiPagesProcessed,
          documentsDiscovered: progress.documentsDiscovered,
          documentsDownloaded: progress.documentsDownloaded,
          documentsFailed: progress.documentsFailed,
        });
      }
    } catch (err: any) {
      addLog(progress, `ERROR storing ${caseName}: ${err.message}`);
      opinionsFailed++;
      progress.documentsFailed++;
    }
  }

  const durationMs = Date.now() - startTime;
  const durationMin = Math.round(durationMs / 60000);
  const durationStr = durationMin >= 1 ? `${durationMin}m` : `${Math.round(durationMs / 1000)}s`;

  let finalStatus: 'completed' | 'completed_with_errors' | 'failed';
  let statusReason: string;

  if (opinionsStored === 0 && opinionsFailed > 0 && matchedClusters.length > 0) {
    finalStatus = 'completed_with_errors';
    statusReason = `All ${opinionsFailed} opinion fetches failed`;
  } else if (opinionsFailed > 0 && opinionsStored > 0) {
    finalStatus = 'completed_with_errors';
    statusReason = `${opinionsStored} opinions stored, ${opinionsFailed} failed`;
  } else if (opinionsStored > 0) {
    finalStatus = 'completed';
    statusReason = `${opinionsStored} new municipal opinions stored`;
  } else if (duplicatesFound > 0) {
    finalStatus = 'completed';
    statusReason = `No new opinions — ${duplicatesFound} already in database`;
  } else if (municipalMatches === 0 && clustersScanned > 0) {
    finalStatus = 'completed';
    statusReason = `No municipal cases found among ${clustersScanned} clusters scanned`;
  } else {
    finalStatus = 'completed';
    statusReason = 'No documents discovered';
  }

  progress.status = finalStatus;
  progress.completedAt = new Date();

  const summary: Record<string, any> = {
    method: 'courtlistener',
    apiPagesProcessed,
    clustersScanned,
    municipalMatches,
    excludeFiltered,
    linkFilterSkipped,
    opinionsStored,
    duplicatesFound,
    opinionsFailed,
    statusReason,
    protectionStats: { detected: false, types: [], blockedPages: 0, blockedDocuments: 0 },
  };

  addLog(progress, `=== COURTLISTENER CRAWL SUMMARY ===`);
  addLog(progress, `SOURCE: ${source.name} (${source.agency})`);
  addLog(progress, `STATUS: ${finalStatus} — ${statusReason}`);
  addLog(progress, `DURATION: ${durationStr}`);
  addLog(progress, `API PAGES: ${apiPagesProcessed}`);
  addLog(progress, `CLUSTERS SCANNED: ${clustersScanned}`);
  addLog(progress, `MUNICIPAL MATCHES: ${municipalMatches}`);
  addLog(progress, `EXCLUDE FILTERED: ${excludeFiltered}`);
  addLog(progress, `LINK FILTER SKIPPED: ${linkFilterSkipped}`);
  addLog(progress, `DUPLICATES: ${duplicatesFound}`);
  addLog(progress, `OPINIONS STORED: ${opinionsStored}`);
  addLog(progress, `OPINIONS FAILED: ${opinionsFailed}`);
  addLog(progress, `=== END COURTLISTENER CRAWL SUMMARY ===`);

  await completeStateSourceRun(run.id, finalStatus, {
    pagesVisited: apiPagesProcessed,
    documentsDiscovered: progress.documentsDiscovered,
    documentsDownloaded: opinionsStored,
    documentsUploaded: opinionsStored,
    documentsFailed: opinionsFailed,
    errorMessage: finalStatus === 'completed' ? undefined : statusReason,
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
