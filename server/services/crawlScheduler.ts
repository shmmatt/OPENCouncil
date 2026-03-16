import { db } from '../storage/db';
import { crawlerTowns } from '../../shared/crawler-schema';
import { eq, and, or, lt, isNull, sql, asc } from 'drizzle-orm';
import { startCrawl, getActiveCrawls } from './crawlerEngine';
import { getCrawlerTownById, createCrawlerRun, getDiscoveredFromSeedUrls } from '../storage/crawler';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const CRAWL_INTERVAL_DAYS = 7;
const MAX_CONSECUTIVE_FAILURES = 3;

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let currentlyCrawling: string | null = null;
let lastRunResult: { runId: string; townSlug: string; error?: string } | null = null;
let startedAt: Date | null = null;

export function isSchedulerRunning(): boolean {
  return isRunning;
}

export function getSchedulerStatus(): {
  running: boolean;
  currentlyCrawling: string | null;
  lastRunResult: { runId: string; townSlug: string; error?: string } | null;
  startedAt: Date | null;
  checkIntervalMinutes: number;
  crawlIntervalDays: number;
} {
  return {
    running: isRunning,
    currentlyCrawling,
    lastRunResult,
    startedAt,
    checkIntervalMinutes: CHECK_INTERVAL_MS / 60000,
    crawlIntervalDays: CRAWL_INTERVAL_DAYS,
  };
}

async function findMostStaleTown(): Promise<{ id: string; slug: string; name: string } | null> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - CRAWL_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

  const results = await db.select({
    id: crawlerTowns.id,
    slug: crawlerTowns.slug,
    name: crawlerTowns.name,
  })
    .from(crawlerTowns)
    .where(and(
      eq(crawlerTowns.status, 'active'),
      or(
        lt(crawlerTowns.consecutiveFailures, MAX_CONSECUTIVE_FAILURES),
        isNull(crawlerTowns.consecutiveFailures),
      ),
      or(
        isNull(crawlerTowns.lastIncrementalCrawl),
        lt(crawlerTowns.lastIncrementalCrawl, staleThreshold),
      ),
    ))
    .orderBy(asc(crawlerTowns.lastIncrementalCrawl))
    .limit(1);

  return results[0] || null;
}

async function runSchedulerCycle(): Promise<void> {
  if (currentlyCrawling) {
    console.log('[CrawlScheduler] Skipping cycle — previous crawl still in progress');
    return;
  }

  try {
    const town = await findMostStaleTown();
    if (!town) {
      console.log('[CrawlScheduler] No stale towns found, sleeping');
      return;
    }

    const anyActive = getActiveCrawls().some(c => c.status === 'running');
    if (anyActive) {
      console.log(`[CrawlScheduler] A crawl is already running, skipping cycle`);
      return;
    }

    console.log(`[CrawlScheduler] Starting incremental crawl for ${town.name} (${town.slug})`);
    currentlyCrawling = town.slug;

    const fullTown = await getCrawlerTownById(town.id);
    if (!fullTown) {
      console.warn(`[CrawlScheduler] Town ${town.id} not found in DB`);
      currentlyCrawling = null;
      return;
    }

    const seedUrls = await getDiscoveredFromSeedUrls(town.id);
    const run = await createCrawlerRun(town.id, 'incremental', 'scheduled', fullTown.maxPages || undefined);
    const runId = await startCrawl(fullTown, run, {
      maxPages: fullTown.maxPages || undefined,
      mode: 'incremental',
      seedUrls,
    });

    lastRunResult = { runId, townSlug: town.slug };
    console.log(`[CrawlScheduler] Incremental crawl started for ${town.name} (runId: ${runId})`);
  } catch (error: any) {
    console.error(`[CrawlScheduler] Unexpected error in cycle: ${error.message}`);
    lastRunResult = { runId: '', townSlug: currentlyCrawling || '', error: error.message };
  } finally {
    currentlyCrawling = null;
  }
}

export function startScheduler(): boolean {
  if (isRunning) {
    console.log('[CrawlScheduler] Already running');
    return false;
  }

  console.log(`[CrawlScheduler] Starting scheduler (check every ${CHECK_INTERVAL_MS / 60000} min, crawl interval ${CRAWL_INTERVAL_DAYS} days)`);
  isRunning = true;
  startedAt = new Date();

  setTimeout(() => runSchedulerCycle(), 5000);

  schedulerInterval = setInterval(() => {
    runSchedulerCycle();
  }, CHECK_INTERVAL_MS);

  return true;
}

export function stopScheduler(): boolean {
  if (!isRunning || !schedulerInterval) {
    console.log('[CrawlScheduler] Not running');
    return false;
  }

  console.log('[CrawlScheduler] Stopping scheduler');
  clearInterval(schedulerInterval);
  schedulerInterval = null;
  isRunning = false;
  startedAt = null;
  return true;
}

export function initSchedulerOnBoot(): void {
  if (process.env.ENABLE_CRAWL_SCHEDULER === 'true') {
    console.log('[CrawlScheduler] Auto-starting from environment variable');
    startScheduler();
  }
}

process.on('SIGTERM', () => {
  if (isRunning) {
    console.log('[CrawlScheduler] SIGTERM received, stopping');
    stopScheduler();
  }
});

process.on('SIGINT', () => {
  if (isRunning) {
    console.log('[CrawlScheduler] SIGINT received, stopping');
    stopScheduler();
  }
});

export async function getStaleTowns(limit: number = 10): Promise<Array<{
  id: string;
  slug: string;
  name: string;
  lastIncrementalCrawl: Date | null;
  lastFullCrawl: Date | null;
  consecutiveFailures: number;
  daysSinceLastCrawl: number | null;
}>> {
  const results = await db.select({
    id: crawlerTowns.id,
    slug: crawlerTowns.slug,
    name: crawlerTowns.name,
    lastIncrementalCrawl: crawlerTowns.lastIncrementalCrawl,
    lastFullCrawl: crawlerTowns.lastFullCrawl,
    consecutiveFailures: crawlerTowns.consecutiveFailures,
  })
    .from(crawlerTowns)
    .where(eq(crawlerTowns.status, 'active'))
    .orderBy(asc(crawlerTowns.lastIncrementalCrawl))
    .limit(limit);

  const now = Date.now();
  return results.map(r => ({
    ...r,
    daysSinceLastCrawl: r.lastIncrementalCrawl
      ? Math.round((now - r.lastIncrementalCrawl.getTime()) / (24 * 60 * 60 * 1000))
      : null,
  }));
}

export async function getIncrementalCrawlStats(days: number = 30): Promise<{
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalDocsDiscovered: number;
  avgDocsPerRun: number;
}> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await db.execute(sql`
    SELECT
      COUNT(*) as total_runs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful_runs,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
      COALESCE(SUM(documents_discovered), 0) as total_docs_discovered,
      CASE WHEN COUNT(*) > 0 THEN COALESCE(SUM(documents_discovered), 0)::float / COUNT(*) ELSE 0 END as avg_docs_per_run
    FROM crawler_runs
    WHERE mode = 'incremental'
    AND started_at > ${since}
  `);

  const row = result.rows?.[0] || result[0] || {};
  return {
    totalRuns: Number(row.total_runs) || 0,
    successfulRuns: Number(row.successful_runs) || 0,
    failedRuns: Number(row.failed_runs) || 0,
    totalDocsDiscovered: Number(row.total_docs_discovered) || 0,
    avgDocsPerRun: Number(row.avg_docs_per_run) || 0,
  };
}
