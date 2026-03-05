import { db, schema, eq, and, sql, desc, gte } from "./db";
import type { DocumentGap, InsertDocumentGap } from "@shared/schema";

export async function createDocumentGap(data: InsertDocumentGap): Promise<DocumentGap> {
  const [result] = await db.insert(schema.documentGaps).values(data).returning();
  return result;
}

export async function findSimilarOpenGap(town: string | null, description: string): Promise<DocumentGap | null> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const descWords = description.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
  if (descWords.length === 0) return null;

  const conditions = [
    gte(schema.documentGaps.createdAt, thirtyDaysAgo),
    sql`${schema.documentGaps.status} IN ('open', 'in_progress')`,
  ];

  if (town) {
    conditions.push(eq(schema.documentGaps.town, town));
  }

  const candidates = await db
    .select()
    .from(schema.documentGaps)
    .where(and(...conditions))
    .orderBy(desc(schema.documentGaps.createdAt))
    .limit(50);

  for (const gap of candidates) {
    const gapWords = gap.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const overlap = descWords.filter(w => gapWords.includes(w)).length;
    if (overlap >= Math.min(3, descWords.length)) {
      return gap;
    }
  }

  return null;
}

export async function incrementGapHitCount(id: string): Promise<void> {
  await db
    .update(schema.documentGaps)
    .set({ hitCount: sql`hit_count + 1` })
    .where(eq(schema.documentGaps.id, id));
}

export interface DocumentGapFilters {
  status?: string;
  town?: string;
  limit?: number;
  offset?: number;
}

export async function getDocumentGaps(filters?: DocumentGapFilters): Promise<DocumentGap[]> {
  const conditions = [];

  if (filters?.status) {
    conditions.push(eq(schema.documentGaps.status, filters.status));
  }
  if (filters?.town) {
    conditions.push(eq(schema.documentGaps.town, filters.town));
  }

  const query = db
    .select()
    .from(schema.documentGaps)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.documentGaps.hitCount), desc(schema.documentGaps.createdAt))
    .limit(filters?.limit ?? 100)
    .offset(filters?.offset ?? 0);

  return await query;
}

export async function getDocumentGapById(id: string): Promise<DocumentGap | undefined> {
  const [result] = await db
    .select()
    .from(schema.documentGaps)
    .where(eq(schema.documentGaps.id, id));
  return result;
}

export async function updateDocumentGap(
  id: string,
  updates: { status?: string; adminNotes?: string; resolvedAt?: Date | null }
): Promise<DocumentGap | undefined> {
  await db
    .update(schema.documentGaps)
    .set(updates)
    .where(eq(schema.documentGaps.id, id));
  return getDocumentGapById(id);
}

export interface DocumentGapStats {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  dismissed: number;
  byTown: { town: string; count: number }[];
  resolvedThisWeek: number;
}

export async function getDocumentGapStats(): Promise<DocumentGapStats> {
  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where status = 'open')::int`,
      inProgress: sql<number>`count(*) filter (where status = 'in_progress')::int`,
      resolved: sql<number>`count(*) filter (where status = 'resolved')::int`,
      dismissed: sql<number>`count(*) filter (where status = 'dismissed')::int`,
      resolvedThisWeek: sql<number>`count(*) filter (where status = 'resolved' and resolved_at >= now() - interval '7 days')::int`,
    })
    .from(schema.documentGaps);

  const byTown = await db
    .select({
      town: schema.documentGaps.town,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.documentGaps)
    .where(eq(schema.documentGaps.status, "open"))
    .groupBy(schema.documentGaps.town)
    .orderBy(sql`count(*) DESC`)
    .limit(10);

  return {
    total: totals?.total ?? 0,
    open: totals?.open ?? 0,
    inProgress: totals?.inProgress ?? 0,
    resolved: totals?.resolved ?? 0,
    dismissed: totals?.dismissed ?? 0,
    byTown: byTown.map(r => ({ town: r.town || "Unknown", count: r.count })),
    resolvedThisWeek: totals?.resolvedThisWeek ?? 0,
  };
}

export async function getDocumentGapTowns(): Promise<string[]> {
  const results = await db
    .select({ town: schema.documentGaps.town })
    .from(schema.documentGaps)
    .groupBy(schema.documentGaps.town)
    .orderBy(schema.documentGaps.town);
  return results.map(r => r.town).filter((t): t is string => t !== null);
}
