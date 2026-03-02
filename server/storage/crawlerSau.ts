import { db, schema, eq, desc, and, sql, asc } from "./db";
import type {
  CrawlerSauSource,
  CrawlerSauSourceRun,
  CrawlerSauDocument,
} from "@shared/schema";

export interface SauSourceOverview extends CrawlerSauSource {
  documentsByStatus: Record<string, number>;
  lastRunStatus: string | null;
  lastRunDate: string | null;
  activeRunId: string | null;
}

export async function getSauSources(): Promise<CrawlerSauSource[]> {
  return db.select().from(schema.crawlerSauSources).orderBy(asc(schema.crawlerSauSources.name));
}

export async function getSauSourceBySlug(slug: string): Promise<CrawlerSauSource | undefined> {
  const [result] = await db
    .select()
    .from(schema.crawlerSauSources)
    .where(eq(schema.crawlerSauSources.slug, slug));
  return result;
}

export async function getSauSourceById(id: string): Promise<CrawlerSauSource | undefined> {
  const [result] = await db
    .select()
    .from(schema.crawlerSauSources)
    .where(eq(schema.crawlerSauSources.id, id));
  return result;
}

export async function createSauSource(data: {
  name: string;
  slug: string;
  sauId: string;
  baseUrl: string;
  description?: string;
  memberTowns?: string[];
  county?: string;
  targetPaths?: string[];
  linkPatterns?: string[];
  excludePatterns?: string[];
  maxPages?: number;
  notes?: string;
}): Promise<CrawlerSauSource> {
  const [result] = await db.insert(schema.crawlerSauSources).values({
    name: data.name,
    slug: data.slug,
    sauId: data.sauId,
    baseUrl: data.baseUrl,
    description: data.description,
    memberTowns: data.memberTowns || [],
    county: data.county,
    targetPaths: data.targetPaths || [],
    linkPatterns: data.linkPatterns || [],
    excludePatterns: data.excludePatterns || [],
    maxPages: data.maxPages || null,
    notes: data.notes,
  }).returning();
  return result;
}

export async function updateSauSource(
  slug: string,
  updates: Partial<Pick<CrawlerSauSource,
    "name" | "baseUrl" | "description" | "memberTowns" |
    "targetPaths" | "linkPatterns" | "excludePatterns" |
    "maxPages" | "status" | "notes"
  >>
): Promise<CrawlerSauSource | undefined> {
  const [result] = await db
    .update(schema.crawlerSauSources)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(schema.crawlerSauSources.slug, slug))
    .returning();
  return result;
}

export async function getSauSourceOverviews(): Promise<SauSourceOverview[]> {
  const sources = await getSauSources();

  const docCounts = await db.execute(sql`
    SELECT source_id, status, COUNT(*) as count
    FROM crawler_sau_documents
    GROUP BY source_id, status
  `);
  const docMap = new Map<string, Record<string, number>>();
  for (const row of docCounts.rows as any[]) {
    if (!docMap.has(row.source_id)) docMap.set(row.source_id, {});
    docMap.get(row.source_id)![row.status] = parseInt(row.count);
  }

  const lastRuns = await db.execute(sql`
    SELECT DISTINCT ON (source_id) source_id, status, started_at, id
    FROM crawler_sau_source_runs
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
    SELECT source_id, id FROM crawler_sau_source_runs WHERE status = 'running'
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

export async function createSauSourceRun(
  sourceId: string,
  mode: string,
  triggerType: string,
  maxPages?: number
): Promise<CrawlerSauSourceRun> {
  const [result] = await db.insert(schema.crawlerSauSourceRuns).values({
    sourceId,
    mode,
    triggerType,
    status: "running",
    maxPagesLimit: maxPages || null,
  }).returning();
  return result;
}

export async function completeSauSourceRun(
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
    .update(schema.crawlerSauSourceRuns)
    .set({
      status,
      completedAt: new Date(),
      ...stats,
    })
    .where(eq(schema.crawlerSauSourceRuns.id, runId));
}

export async function getSauSourceRuns(
  sourceId?: string,
  limit = 50,
  offset = 0
): Promise<{ runs: CrawlerSauSourceRun[]; total: number }> {
  const conditions = sourceId ? [eq(schema.crawlerSauSourceRuns.sourceId, sourceId)] : [];

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerSauSourceRuns)
    .where(conditions.length ? and(...conditions) : undefined);

  const runs = await db
    .select()
    .from(schema.crawlerSauSourceRuns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.crawlerSauSourceRuns.startedAt))
    .limit(limit)
    .offset(offset);

  return { runs, total: Number(countResult.count) };
}

export async function recordSauDocument(
  sourceId: string,
  doc: {
    url: string;
    urlHash: string;
    filename: string;
    category?: string;
    title?: string;
    sizeBytes?: number;
    mimeType?: string;
    s3Key?: string;
    discoveredFrom?: string;
    status?: string;
    fileBlobId?: string;
  }
): Promise<CrawlerSauDocument> {
  const [result] = await db
    .insert(schema.crawlerSauDocuments)
    .values({
      sourceId,
      url: doc.url,
      urlHash: doc.urlHash,
      filename: doc.filename,
      category: doc.category,
      title: doc.title,
      sizeBytes: doc.sizeBytes,
      mimeType: doc.mimeType,
      s3Key: doc.s3Key,
      discoveredFrom: doc.discoveredFrom,
      status: doc.status || "discovered",
      fileBlobId: doc.fileBlobId,
    })
    .onConflictDoUpdate({
      target: schema.crawlerSauDocuments.urlHash,
      set: {
        filename: doc.filename,
        category: doc.category,
        title: doc.title,
        sizeBytes: doc.sizeBytes,
        mimeType: doc.mimeType,
        s3Key: doc.s3Key,
        status: doc.status || "discovered",
        fileBlobId: doc.fileBlobId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result;
}

export async function getSauDocuments(
  sourceId?: string,
  filters?: {
    status?: string;
    category?: string;
    search?: string;
  },
  limit = 100,
  offset = 0
): Promise<{ documents: CrawlerSauDocument[]; total: number }> {
  const conditions: any[] = [];
  if (sourceId) conditions.push(eq(schema.crawlerSauDocuments.sourceId, sourceId));
  if (filters?.status) conditions.push(eq(schema.crawlerSauDocuments.status, filters.status));
  if (filters?.category) conditions.push(eq(schema.crawlerSauDocuments.category, filters.category));

  let whereClause = conditions.length ? and(...conditions) : undefined;

  if (filters?.search) {
    const searchCondition = sql`(${schema.crawlerSauDocuments.filename} ILIKE ${'%' + filters.search + '%'} OR ${schema.crawlerSauDocuments.url} ILIKE ${'%' + filters.search + '%'} OR ${schema.crawlerSauDocuments.title} ILIKE ${'%' + filters.search + '%'})`;
    whereClause = whereClause ? and(whereClause, searchCondition) : searchCondition;
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerSauDocuments)
    .where(whereClause);

  const documents = await db
    .select()
    .from(schema.crawlerSauDocuments)
    .where(whereClause)
    .orderBy(desc(schema.crawlerSauDocuments.discoveredAt))
    .limit(limit)
    .offset(offset);

  return { documents, total: Number(countResult.count) };
}

export async function updateSauSourceStats(sourceId: string): Promise<void> {
  const docStats = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'uploaded') as uploaded
    FROM crawler_sau_documents
    WHERE source_id = ${sourceId}
  `);

  const row = (docStats.rows as any[])[0];
  const totalDocuments = parseInt(row.total || "0");
  const totalUploaded = parseInt(row.uploaded || "0");

  await db
    .update(schema.crawlerSauSources)
    .set({
      totalDocuments,
      totalUploaded,
      updatedAt: new Date(),
    })
    .where(eq(schema.crawlerSauSources.id, sourceId));
}

export async function getSauSourceStats(): Promise<{
  totalSources: number;
  totalDocuments: number;
  totalUploaded: number;
  totalFailed: number;
  activeRuns: number;
}> {
  const [sourceCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerSauSources);

  const docStats = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'uploaded') as uploaded,
      COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM crawler_sau_documents
  `);

  const [activeCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.crawlerSauSourceRuns)
    .where(eq(schema.crawlerSauSourceRuns.status, "running"));

  const docRow = (docStats.rows as any[])[0];

  return {
    totalSources: Number(sourceCount.count),
    totalDocuments: parseInt(docRow.total || "0"),
    totalUploaded: parseInt(docRow.uploaded || "0"),
    totalFailed: parseInt(docRow.failed || "0"),
    activeRuns: Number(activeCount.count),
  };
}
