/**
 * Crawler State Manager
 * 
 * Manages persistent state for the document crawler:
 * - Town registry and metadata
 * - Sitemap tracking and diffing
 * - Document discovery and upload tracking
 * - Crawl run history
 */

import { db } from '../storage/db';
import { 
  crawlerTowns, 
  crawlerSitemaps, 
  crawlerUrls, 
  crawlerDocuments,
  crawlerRuns,
  type InsertCrawlerTown,
  type InsertCrawlerSitemap,
  type InsertCrawlerUrl,
  type InsertCrawlerDocument,
  type InsertCrawlerRun,
  type CrawlerTown,
  type CrawlerSitemap,
  type CrawlerDocument,
  type CrawlerRun,
  type SitemapUrl,
  type CrawlRunSummary
} from '../../shared/crawler-schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import * as crypto from 'crypto';

// ============================================================
// TOWN MANAGEMENT
// ============================================================

export async function getTown(slug: string): Promise<CrawlerTown | null> {
  const [town] = await db.select().from(crawlerTowns).where(eq(crawlerTowns.slug, slug));
  return town || null;
}

export async function getTownById(id: string): Promise<CrawlerTown | null> {
  const [town] = await db.select().from(crawlerTowns).where(eq(crawlerTowns.id, id));
  return town || null;
}

export async function getAllTowns(): Promise<CrawlerTown[]> {
  return db.select().from(crawlerTowns).orderBy(crawlerTowns.name);
}

export async function getActiveTowns(): Promise<CrawlerTown[]> {
  return db.select()
    .from(crawlerTowns)
    .where(eq(crawlerTowns.status, 'active'))
    .orderBy(crawlerTowns.name);
}

export async function createTown(town: InsertCrawlerTown): Promise<CrawlerTown> {
  const [created] = await db.insert(crawlerTowns).values(town).returning();
  return created;
}

export async function updateTown(slug: string, updates: Partial<InsertCrawlerTown>): Promise<CrawlerTown> {
  const [updated] = await db.update(crawlerTowns)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(crawlerTowns.slug, slug))
    .returning();
  return updated;
}

export async function updateTownStats(townId: string, stats: {
  totalDocuments?: number;
  totalUploaded?: number;
  lastCrawlDocsFound?: number;
  lastFullCrawl?: Date;
  lastIncrementalCrawl?: Date;
}): Promise<void> {
  await db.update(crawlerTowns)
    .set({ ...stats, updatedAt: new Date() })
    .where(eq(crawlerTowns.id, townId));
}

export async function incrementFailureCount(townId: string): Promise<void> {
  await db.execute(sql`
    UPDATE crawler_towns
    SET consecutive_failures = consecutive_failures + 1,
        updated_at = NOW()
    WHERE id = ${townId}
  `);
}

export async function resetFailureCount(townId: string): Promise<void> {
  await db.update(crawlerTowns)
    .set({ consecutiveFailures: 0, updatedAt: new Date() })
    .where(eq(crawlerTowns.id, townId));
}

// ============================================================
// SITEMAP MANAGEMENT
// ============================================================

export function hashSitemap(sitemapXml: string): string {
  return crypto.createHash('sha256').update(sitemapXml).digest('hex');
}

export async function getLatestSitemap(townId: string): Promise<CrawlerSitemap | null> {
  const [sitemap] = await db.select()
    .from(crawlerSitemaps)
    .where(eq(crawlerSitemaps.townId, townId))
    .orderBy(desc(crawlerSitemaps.lastChecked))
    .limit(1);
  return sitemap || null;
}

export async function saveSitemap(sitemap: InsertCrawlerSitemap): Promise<CrawlerSitemap> {
  const [created] = await db.insert(crawlerSitemaps).values(sitemap).returning();
  return created;
}

export async function updateSitemapLastChecked(sitemapId: string): Promise<void> {
  await db.update(crawlerSitemaps)
    .set({ lastChecked: new Date() })
    .where(eq(crawlerSitemaps.id, sitemapId));
}

/**
 * Compare current sitemap with latest stored version
 * Returns new URLs and changed URLs
 */
export async function diffSitemap(
  townId: string,
  currentUrls: SitemapUrl[],
  currentHash: string
): Promise<{
  isChanged: boolean;
  newUrls: SitemapUrl[];
  removedUrls: SitemapUrl[];
  sitemapId?: string;
}> {
  const latest = await getLatestSitemap(townId);
  
  if (!latest) {
    // No previous sitemap - everything is new
    return {
      isChanged: true,
      newUrls: currentUrls,
      removedUrls: [],
    };
  }
  
  // Hash comparison for quick check
  if (latest.hash === currentHash) {
    // Sitemap unchanged, update last checked timestamp
    await updateSitemapLastChecked(latest.id);
    return {
      isChanged: false,
      newUrls: [],
      removedUrls: [],
      sitemapId: latest.id,
    };
  }
  
  // Sitemap changed - find differences
  const previousUrls = latest.urls;
  const previousUrlSet = new Set(previousUrls.map(u => u.url));
  const currentUrlSet = new Set(currentUrls.map(u => u.url));
  
  const newUrls = currentUrls.filter(u => !previousUrlSet.has(u.url));
  const removedUrls = previousUrls.filter(u => !currentUrlSet.has(u.url));
  
  return {
    isChanged: true,
    newUrls,
    removedUrls,
    sitemapId: latest.id,
  };
}

// ============================================================
// URL MANAGEMENT
// ============================================================

export function hashUrl(url: string): string {
  // Normalize URL before hashing
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = u.search.replace(/[?&](session|token|sid)=[^&]*/g, '');
    return crypto.createHash('sha256').update(u.href).digest('hex');
  } catch {
    return crypto.createHash('sha256').update(url).digest('hex');
  }
}

export async function recordUrl(url: InsertCrawlerUrl): Promise<void> {
  // Upsert - update if exists, insert if new
  await db.insert(crawlerUrls)
    .values(url)
    .onConflictDoUpdate({
      target: [crawlerUrls.townId, crawlerUrls.urlHash],
      set: {
        lastVisited: new Date(),
        visitCount: sql`${crawlerUrls.visitCount} + 1`,
      },
    });
}

export async function markUrlVisited(townId: string, urlHash: string, docCount: number): Promise<void> {
  await db.update(crawlerUrls)
    .set({
      lastVisited: new Date(),
      visitCount: sql`${crawlerUrls.visitCount} + 1`,
      documentCount: docCount,
      status: 'visited',
    })
    .where(and(
      eq(crawlerUrls.townId, townId),
      eq(crawlerUrls.urlHash, urlHash)
    ));
}

export async function getPendingUrls(townId: string, priority: 'high' | 'medium' | 'low' | null = null): Promise<string[]> {
  let query = db.select({ url: crawlerUrls.url })
    .from(crawlerUrls)
    .where(and(
      eq(crawlerUrls.townId, townId),
      eq(crawlerUrls.status, 'pending')
    ))
    .orderBy(crawlerUrls.firstDiscovered);
  
  if (priority) {
    query = query.where(eq(crawlerUrls.priority, priority));
  }
  
  const results = await query;
  return results.map(r => r.url);
}

// ============================================================
// DOCUMENT MANAGEMENT
// ============================================================

export async function recordDocument(doc: InsertCrawlerDocument): Promise<CrawlerDocument> {
  const [created] = await db.insert(crawlerDocuments)
    .values(doc)
    .onConflictDoUpdate({
      target: crawlerDocuments.urlHash,
      set: {
        status: doc.status,
        s3Key: doc.s3Key,
        s3UploadedAt: doc.s3UploadedAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  return created;
}

export async function getDocument(urlHash: string): Promise<CrawlerDocument | null> {
  const [doc] = await db.select()
    .from(crawlerDocuments)
    .where(eq(crawlerDocuments.urlHash, urlHash));
  return doc || null;
}

export async function isDocumentKnown(urlHash: string): Promise<boolean> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(crawlerDocuments)
    .where(eq(crawlerDocuments.urlHash, urlHash));
  return result.count > 0;
}

export async function getTownDocuments(townId: string, status?: string): Promise<CrawlerDocument[]> {
  let query = db.select()
    .from(crawlerDocuments)
    .where(eq(crawlerDocuments.townId, townId))
    .orderBy(desc(crawlerDocuments.discoveredAt));
  
  if (status) {
    query = query.where(eq(crawlerDocuments.status, status));
  }
  
  return query;
}

export async function markDocumentUploaded(urlHash: string, s3Key: string): Promise<void> {
  await db.update(crawlerDocuments)
    .set({
      s3Key,
      s3UploadedAt: new Date(),
      status: 'uploaded',
      updatedAt: new Date(),
    })
    .where(eq(crawlerDocuments.urlHash, urlHash));
}

export async function markDocumentFailed(urlHash: string, error: string): Promise<void> {
  await db.update(crawlerDocuments)
    .set({
      status: 'failed',
      errorMessage: error,
      updatedAt: new Date(),
    })
    .where(eq(crawlerDocuments.urlHash, urlHash));
}

export async function getDocumentStats(townId: string): Promise<{
  total: number;
  discovered: number;
  downloaded: number;
  uploaded: number;
  failed: number;
}> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'discovered' THEN 1 ELSE 0 END) as discovered,
      SUM(CASE WHEN status = 'downloaded' THEN 1 ELSE 0 END) as downloaded,
      SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) as uploaded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM crawler_documents
    WHERE town_id = ${townId}
  `);
  
  const stats = result.rows?.[0] || result[0] || {};
  
  return {
    total: Number(stats.total) || 0,
    discovered: Number(stats.discovered) || 0,
    downloaded: Number(stats.downloaded) || 0,
    uploaded: Number(stats.uploaded) || 0,
    failed: Number(stats.failed) || 0,
  };
}

// ============================================================
// RUN MANAGEMENT
// ============================================================

export async function createRun(run: InsertCrawlerRun): Promise<CrawlerRun> {
  const [created] = await db.insert(crawlerRuns).values(run).returning();
  return created;
}

export async function updateRun(runId: string, updates: Partial<InsertCrawlerRun>): Promise<void> {
  await db.update(crawlerRuns)
    .set(updates)
    .where(eq(crawlerRuns.id, runId));
}

export async function completeRun(
  runId: string,
  status: 'completed' | 'failed' | 'timeout',
  summary?: CrawlRunSummary,
  error?: string
): Promise<void> {
  await db.update(crawlerRuns)
    .set({
      completedAt: new Date(),
      status,
      summary,
      errorMessage: error,
    })
    .where(eq(crawlerRuns.id, runId));
}

export async function getLatestRun(townId: string): Promise<CrawlerRun | null> {
  const [run] = await db.select()
    .from(crawlerRuns)
    .where(eq(crawlerRuns.townId, townId))
    .orderBy(desc(crawlerRuns.startedAt))
    .limit(1);
  return run || null;
}

export async function getTownRuns(townId: string, limit: number = 10): Promise<CrawlerRun[]> {
  return db.select()
    .from(crawlerRuns)
    .where(eq(crawlerRuns.townId, townId))
    .orderBy(desc(crawlerRuns.startedAt))
    .limit(limit);
}

// ============================================================
// COMPOSITE QUERIES
// ============================================================

/**
 * Get comprehensive town state for crawl planning
 */
export async function getTownState(slug: string): Promise<{
  town: CrawlerTown;
  latestSitemap: CrawlerSitemap | null;
  latestRun: CrawlerRun | null;
  documentStats: Awaited<ReturnType<typeof getDocumentStats>>;
} | null> {
  const town = await getTown(slug);
  if (!town) return null;
  
  const [latestSitemap, latestRun, documentStats] = await Promise.all([
    getLatestSitemap(town.id),
    getLatestRun(town.id),
    getDocumentStats(town.id),
  ]);
  
  return {
    town,
    latestSitemap,
    latestRun,
    documentStats,
  };
}

/**
 * Batch upsert documents from crawl run
 */
export async function batchRecordDocuments(docs: InsertCrawlerDocument[]): Promise<number> {
  if (docs.length === 0) return 0;
  
  const results = await Promise.allSettled(
    docs.map(doc => recordDocument(doc))
  );
  
  const successful = results.filter(r => r.status === 'fulfilled').length;
  return successful;
}
