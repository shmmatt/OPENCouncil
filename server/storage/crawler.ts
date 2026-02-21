import { db, schema, eq, desc, and, sql, asc } from "./db";
import type {
  CrawlerTown,
  CrawlerRun,
  CrawlerDocument,
  CrawlerUrl,
  CrawlerStateSource,
  CrawlerStateSourceRun,
  CrawlerStateDocument,
} from "@shared/schema";

export async function getCrawlerTowns(): Promise<CrawlerTown[]> {
  return db.select().from(schema.crawlerTowns).orderBy(asc(schema.crawlerTowns.name));
}

export async function getCrawlerTownById(id: string): Promise<CrawlerTown | undefined> {
  const [result] = await db
    .select()
    .from(schema.crawlerTowns)
    .where(eq(schema.crawlerTowns.id, id));
  return result;
}

export async function getCrawlerTownBySlug(slug: string): Promise<CrawlerTown | undefined> {
  const [result] = await db
    .select()
    .from(schema.crawlerTowns)
    .where(eq(schema.crawlerTowns.slug, slug));
  return result;
}

export async function updateCrawlerTown(
  id: string,
  updates: Partial<Pick<CrawlerTown, "cms" | "maxPages" | "customPaths" | "status" | "url">>
): Promise<CrawlerTown | undefined> {
  const [result] = await db
    .update(schema.crawlerTowns)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(schema.crawlerTowns.id, id))
    .returning();
  return result;
}

export interface TownOverview extends CrawlerTown {
  urlCount: number;
  documentsByStatus: Record<string, number>;
  lastRunStatus: string | null;
  lastRunDate: string | null;
  activeRunId: string | null;
}

export async function getTownOverviews(): Promise<TownOverview[]> {
  const towns = await getCrawlerTowns();

  const urlCounts = await db.execute(sql`
    SELECT town_id, COUNT(*) as count
    FROM crawler_urls
    GROUP BY town_id
  `);
  const urlMap = new Map<string, number>();
  for (const row of urlCounts.rows as any[]) {
    urlMap.set(row.town_id, parseInt(row.count));
  }

  const docCounts = await db.execute(sql`
    SELECT town_id, status, COUNT(*) as count
    FROM crawler_documents
    GROUP BY town_id, status
  `);
  const docMap = new Map<string, Record<string, number>>();
  for (const row of docCounts.rows as any[]) {
    if (!docMap.has(row.town_id)) docMap.set(row.town_id, {});
    docMap.get(row.town_id)![row.status] = parseInt(row.count);
  }

  const lastRuns = await db.execute(sql`
    SELECT DISTINCT ON (town_id) town_id, status, started_at, id
    FROM crawler_runs
    ORDER BY town_id, started_at DESC
  `);
  const runMap = new Map<string, { status: string; date: string; id: string }>();
  for (const row of lastRuns.rows as any[]) {
    runMap.set(row.town_id, {
      status: row.status,
      date: row.started_at,
      id: row.id,
    });
  }

  const activeRuns = await db.execute(sql`
    SELECT town_id, id FROM crawler_runs WHERE status = 'running'
  `);
  const activeMap = new Map<string, string>();
  for (const row of activeRuns.rows as any[]) {
    activeMap.set(row.town_id, row.id);
  }

  return towns.map((town) => ({
    ...town,
    urlCount: urlMap.get(town.id) || 0,
    documentsByStatus: docMap.get(town.id) || {},
    lastRunStatus: runMap.get(town.id)?.status || null,
    lastRunDate: runMap.get(town.id)?.date || null,
    activeRunId: activeMap.get(town.id) || null,
  }));
}

export async function getCrawlerRuns(
  townId?: string,
  limit = 50,
  offset = 0
): Promise<{ runs: CrawlerRun[]; total: number }> {
  const conditions = townId ? [eq(schema.crawlerRuns.townId, townId)] : [];

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerRuns)
    .where(conditions.length ? and(...conditions) : undefined);

  const runs = await db
    .select()
    .from(schema.crawlerRuns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.crawlerRuns.startedAt))
    .limit(limit)
    .offset(offset);

  return { runs, total: Number(countResult.count) };
}

export async function getCrawlerRunById(id: string): Promise<CrawlerRun | undefined> {
  const [result] = await db
    .select()
    .from(schema.crawlerRuns)
    .where(eq(schema.crawlerRuns.id, id));
  return result;
}

export async function getCrawlerDocuments(
  townId?: string,
  status?: string,
  limit = 100,
  offset = 0,
  search?: string
): Promise<{ documents: CrawlerDocument[]; total: number }> {
  const conditions: any[] = [];
  if (townId) conditions.push(eq(schema.crawlerDocuments.townId, townId));
  if (status) conditions.push(eq(schema.crawlerDocuments.status, status));

  let whereClause = conditions.length ? and(...conditions) : undefined;

  if (search) {
    const searchCondition = sql`(${schema.crawlerDocuments.filename} ILIKE ${'%' + search + '%'} OR ${schema.crawlerDocuments.url} ILIKE ${'%' + search + '%'})`;
    whereClause = whereClause ? and(whereClause, searchCondition) : searchCondition;
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerDocuments)
    .where(whereClause);

  const documents = await db
    .select()
    .from(schema.crawlerDocuments)
    .where(whereClause)
    .orderBy(desc(schema.crawlerDocuments.discoveredAt))
    .limit(limit)
    .offset(offset);

  return { documents, total: Number(countResult.count) };
}

export async function getCrawlerUrls(
  townId: string,
  status?: string,
  limit = 100,
  offset = 0
): Promise<{ urls: CrawlerUrl[]; total: number }> {
  const conditions: any[] = [eq(schema.crawlerUrls.townId, townId)];
  if (status) conditions.push(eq(schema.crawlerUrls.status, status));

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerUrls)
    .where(and(...conditions));

  const urls = await db
    .select()
    .from(schema.crawlerUrls)
    .where(and(...conditions))
    .orderBy(desc(schema.crawlerUrls.firstDiscovered))
    .limit(limit)
    .offset(offset);

  return { urls, total: Number(countResult.count) };
}

export async function getRunComparison(runId: string): Promise<{
  newDocuments: number;
  alreadyKnown: number;
  failed: number;
}> {
  const run = await getCrawlerRunById(runId);
  if (!run) return { newDocuments: 0, alreadyKnown: 0, failed: 0 };

  const endTime = run.completedAt || new Date();

  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE discovered_at >= ${run.startedAt} AND discovered_at <= ${endTime} AND status IN ('uploaded', 'downloaded', 'discovered')) as new_docs,
      COUNT(*) FILTER (WHERE discovered_at < ${run.startedAt} AND status = 'uploaded') as already_known,
      COUNT(*) FILTER (WHERE discovered_at >= ${run.startedAt} AND discovered_at <= ${endTime} AND status = 'failed') as failed
    FROM crawler_documents
    WHERE town_id = ${run.townId}
  `);

  const row = (result.rows as any[])[0];
  return {
    newDocuments: parseInt(row.new_docs || "0"),
    alreadyKnown: parseInt(row.already_known || "0"),
    failed: parseInt(row.failed || "0"),
  };
}

export async function resetOrphanedRuns(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE crawler_runs
    SET status = 'failed',
        error_message = 'Process exited without reporting final status',
        completed_at = NOW()
    WHERE status = 'running'
  `);
  return result.rowCount || 0;
}

export async function createCrawlerRun(townId: string, mode: string, triggerType: string, maxPages?: number): Promise<CrawlerRun> {
  const [result] = await db.insert(schema.crawlerRuns).values({
    townId,
    mode,
    triggerType,
    status: "running",
    maxPagesLimit: maxPages || null,
  }).returning();
  return result;
}

export async function completeCrawlerRun(
  runId: string,
  status: string,
  stats: {
    pagesVisited?: number;
    documentsDiscovered?: number;
    documentsDownloaded?: number;
    documentsUploaded?: number;
    documentsFailed?: number;
    errorMessage?: string;
    summary?: any;
  }
): Promise<void> {
  await db
    .update(schema.crawlerRuns)
    .set({
      status,
      completedAt: new Date(),
      ...stats,
    })
    .where(eq(schema.crawlerRuns.id, runId));
}

export async function getCrawlerStats(): Promise<{
  totalTowns: number;
  totalDocuments: number;
  totalUploaded: number;
  totalFailed: number;
  totalUrls: number;
  activeRuns: number;
  recentRuns: CrawlerRun[];
}> {
  const [townCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerTowns);

  const docStats = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'uploaded') as uploaded,
      COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM crawler_documents
  `);

  const [urlCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerUrls);

  const [activeCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerRuns)
    .where(eq(schema.crawlerRuns.status, "running"));

  const recentRuns = await db
    .select()
    .from(schema.crawlerRuns)
    .orderBy(desc(schema.crawlerRuns.startedAt))
    .limit(10);

  const docRow = (docStats.rows as any[])[0];

  return {
    totalTowns: Number(townCount.count),
    totalDocuments: parseInt(docRow.total || "0"),
    totalUploaded: parseInt(docRow.uploaded || "0"),
    totalFailed: parseInt(docRow.failed || "0"),
    totalUrls: Number(urlCount.count),
    activeRuns: Number(activeCount.count),
    recentRuns,
  };
}

// ============================================================
// STATE SOURCE STORAGE
// ============================================================

export async function getStateSources(): Promise<CrawlerStateSource[]> {
  return db.select().from(schema.crawlerStateSources).orderBy(asc(schema.crawlerStateSources.agency));
}

export async function getStateSourceById(id: string): Promise<CrawlerStateSource | undefined> {
  const [result] = await db
    .select()
    .from(schema.crawlerStateSources)
    .where(eq(schema.crawlerStateSources.id, id));
  return result;
}

export async function getStateSourceBySlug(slug: string): Promise<CrawlerStateSource | undefined> {
  const [result] = await db
    .select()
    .from(schema.crawlerStateSources)
    .where(eq(schema.crawlerStateSources.slug, slug));
  return result;
}

export async function updateStateSource(
  id: string,
  updates: Partial<Pick<CrawlerStateSource,
    "name" | "agency" | "agencyAbbrev" | "baseUrl" | "description" |
    "docCategories" | "targetPaths" | "linkPatterns" | "excludePatterns" |
    "updateCadence" | "maxPages" | "status" | "notes"
  >>
): Promise<CrawlerStateSource | undefined> {
  const [result] = await db
    .update(schema.crawlerStateSources)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(schema.crawlerStateSources.id, id))
    .returning();
  return result;
}

export interface StateSourceOverview extends CrawlerStateSource {
  documentsByStatus: Record<string, number>;
  lastRunStatus: string | null;
  lastRunDate: string | null;
  activeRunId: string | null;
}

export async function getStateSourceOverviews(): Promise<StateSourceOverview[]> {
  const sources = await getStateSources();

  const docCounts = await db.execute(sql`
    SELECT source_id, status, COUNT(*) as count
    FROM crawler_state_documents
    GROUP BY source_id, status
  `);
  const docMap = new Map<string, Record<string, number>>();
  for (const row of docCounts.rows as any[]) {
    if (!docMap.has(row.source_id)) docMap.set(row.source_id, {});
    docMap.get(row.source_id)![row.status] = parseInt(row.count);
  }

  const lastRuns = await db.execute(sql`
    SELECT DISTINCT ON (source_id) source_id, status, started_at, id
    FROM crawler_state_source_runs
    ORDER BY source_id, started_at DESC
  `);
  const runMap = new Map<string, { status: string; date: string; id: string }>();
  for (const row of lastRuns.rows as any[]) {
    runMap.set(row.source_id, {
      status: row.status,
      date: row.started_at,
      id: row.id,
    });
  }

  const activeRuns = await db.execute(sql`
    SELECT source_id, id FROM crawler_state_source_runs WHERE status = 'running'
  `);
  const activeMap = new Map<string, string>();
  for (const row of activeRuns.rows as any[]) {
    activeMap.set(row.source_id, row.id);
  }

  return sources.map((source) => ({
    ...source,
    documentsByStatus: docMap.get(source.id) || {},
    lastRunStatus: runMap.get(source.id)?.status || null,
    lastRunDate: runMap.get(source.id)?.date || null,
    activeRunId: activeMap.get(source.id) || null,
  }));
}

export async function getStateSourceRuns(
  sourceId?: string,
  limit = 50,
  offset = 0
): Promise<{ runs: CrawlerStateSourceRun[]; total: number }> {
  const conditions = sourceId ? [eq(schema.crawlerStateSourceRuns.sourceId, sourceId)] : [];

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerStateSourceRuns)
    .where(conditions.length ? and(...conditions) : undefined);

  const runs = await db
    .select()
    .from(schema.crawlerStateSourceRuns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.crawlerStateSourceRuns.startedAt))
    .limit(limit)
    .offset(offset);

  return { runs, total: Number(countResult.count) };
}

export async function createStateSourceRun(
  sourceId: string,
  mode: string,
  triggerType: string,
  maxPages?: number
): Promise<CrawlerStateSourceRun> {
  const [result] = await db.insert(schema.crawlerStateSourceRuns).values({
    sourceId,
    mode,
    triggerType,
    status: "running",
    maxPagesLimit: maxPages || null,
  }).returning();
  return result;
}

export async function completeStateSourceRun(
  runId: string,
  status: string,
  stats: {
    pagesVisited?: number;
    documentsDiscovered?: number;
    documentsDownloaded?: number;
    documentsUploaded?: number;
    documentsFailed?: number;
    errorMessage?: string;
    summary?: any;
  }
): Promise<void> {
  await db
    .update(schema.crawlerStateSourceRuns)
    .set({
      status,
      completedAt: new Date(),
      ...stats,
    })
    .where(eq(schema.crawlerStateSourceRuns.id, runId));
}

export async function getStateDocuments(
  sourceId?: string,
  status?: string,
  limit = 100,
  offset = 0,
  search?: string
): Promise<{ documents: CrawlerStateDocument[]; total: number }> {
  const conditions: any[] = [];
  if (sourceId) conditions.push(eq(schema.crawlerStateDocuments.sourceId, sourceId));
  if (status) conditions.push(eq(schema.crawlerStateDocuments.status, status));

  let whereClause = conditions.length ? and(...conditions) : undefined;

  if (search) {
    const searchCondition = sql`(${schema.crawlerStateDocuments.filename} ILIKE ${'%' + search + '%'} OR ${schema.crawlerStateDocuments.url} ILIKE ${'%' + search + '%'} OR ${schema.crawlerStateDocuments.title} ILIKE ${'%' + search + '%'})`;
    whereClause = whereClause ? and(whereClause, searchCondition) : searchCondition;
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerStateDocuments)
    .where(whereClause);

  const documents = await db
    .select()
    .from(schema.crawlerStateDocuments)
    .where(whereClause)
    .orderBy(desc(schema.crawlerStateDocuments.discoveredAt))
    .limit(limit)
    .offset(offset);

  return { documents, total: Number(countResult.count) };
}

export async function getStateSourceStats(): Promise<{
  totalSources: number;
  totalDocuments: number;
  totalUploaded: number;
  totalFailed: number;
  activeRuns: number;
}> {
  const [sourceCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerStateSources);

  const docStats = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'uploaded') as uploaded,
      COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM crawler_state_documents
  `);

  const [activeCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerStateSourceRuns)
    .where(eq(schema.crawlerStateSourceRuns.status, "running"));

  const docRow = (docStats.rows as any[])[0];

  return {
    totalSources: Number(sourceCount.count),
    totalDocuments: parseInt(docRow.total || "0"),
    totalUploaded: parseInt(docRow.uploaded || "0"),
    totalFailed: parseInt(docRow.failed || "0"),
    activeRuns: Number(activeCount.count),
  };
}
