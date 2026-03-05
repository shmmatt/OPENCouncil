import { db, schema, eq, desc, sql } from "./db";
import type {
  DeepDiveSession,
  InsertDeepDiveSession,
  DeepDiveStep,
  InsertDeepDiveStep,
} from "@shared/schema";

export async function createDeepDiveSession(data: InsertDeepDiveSession): Promise<DeepDiveSession> {
  const [result] = await db.insert(schema.deepDiveSessions).values(data).returning();
  return result;
}

export async function updateDeepDiveSession(
  id: string,
  updates: Partial<Pick<DeepDiveSession, 'status' | 'finalAnswer' | 'qualityScore' | 'completenessScore' | 'iterationCount' | 'totalCostUsd' | 'totalDurationMs' | 'completedAt'>>
): Promise<void> {
  await db.update(schema.deepDiveSessions)
    .set(updates)
    .where(eq(schema.deepDiveSessions.id, id));
}

export async function getDeepDiveSession(id: string): Promise<DeepDiveSession | undefined> {
  const [result] = await db.select()
    .from(schema.deepDiveSessions)
    .where(eq(schema.deepDiveSessions.id, id));
  return result;
}

export async function getDeepDiveSessions(opts?: {
  limit?: number;
  offset?: number;
  status?: string;
  town?: string;
}): Promise<{ sessions: DeepDiveSession[]; total: number }> {
  const limit = opts?.limit || 20;
  const offset = opts?.offset || 0;

  let conditions: any[] = [];
  if (opts?.status) {
    conditions.push(eq(schema.deepDiveSessions.status, opts.status));
  }
  if (opts?.town) {
    conditions.push(eq(schema.deepDiveSessions.town, opts.town));
  }

  const whereClause = conditions.length > 0
    ? sql`${sql.join(conditions.map(c => c), sql` AND `)}`
    : undefined;

  const [countResult] = await db.select({ count: sql<number>`count(*)::int` })
    .from(schema.deepDiveSessions)
    .where(whereClause);

  const sessions = await db.select()
    .from(schema.deepDiveSessions)
    .where(whereClause)
    .orderBy(desc(schema.deepDiveSessions.createdAt))
    .limit(limit)
    .offset(offset);

  return { sessions, total: countResult?.count || 0 };
}

export async function getDeepDiveSessionByChatMessage(messageId: string): Promise<DeepDiveSession | undefined> {
  const [result] = await db.select()
    .from(schema.deepDiveSessions)
    .where(eq(schema.deepDiveSessions.messageId, messageId));
  return result;
}

export async function createDeepDiveStep(data: InsertDeepDiveStep): Promise<DeepDiveStep> {
  const [result] = await db.insert(schema.deepDiveSteps).values(data).returning();
  return result;
}

export async function getDeepDiveSteps(deepDiveId: string): Promise<DeepDiveStep[]> {
  return db.select()
    .from(schema.deepDiveSteps)
    .where(eq(schema.deepDiveSteps.deepDiveId, deepDiveId))
    .orderBy(schema.deepDiveSteps.stepNumber);
}

export async function getDeepDiveStats(): Promise<{
  totalDives: number;
  avgQualityScore: number | null;
  avgCompletenessScore: number | null;
  avgCostUsd: number | null;
  avgIterations: number | null;
  avgDurationMs: number | null;
  completedCount: number;
  failedCount: number;
  runningCount: number;
}> {
  const [result] = await db.select({
    totalDives: sql<number>`count(*)::int`,
    avgQualityScore: sql<number | null>`avg(quality_score)`,
    avgCompletenessScore: sql<number | null>`avg(completeness_score)`,
    avgCostUsd: sql<number | null>`avg(total_cost_usd::float)`,
    avgIterations: sql<number | null>`avg(iteration_count)`,
    avgDurationMs: sql<number | null>`avg(total_duration_ms)`,
    completedCount: sql<number>`count(*) filter (where status = 'completed')::int`,
    failedCount: sql<number>`count(*) filter (where status = 'failed')::int`,
    runningCount: sql<number>`count(*) filter (where status = 'running')::int`,
  }).from(schema.deepDiveSessions);

  return {
    totalDives: result?.totalDives || 0,
    avgQualityScore: result?.avgQualityScore ? Number(result.avgQualityScore) : null,
    avgCompletenessScore: result?.avgCompletenessScore ? Number(result.avgCompletenessScore) : null,
    avgCostUsd: result?.avgCostUsd ? Number(result.avgCostUsd) : null,
    avgIterations: result?.avgIterations ? Number(result.avgIterations) : null,
    avgDurationMs: result?.avgDurationMs ? Number(result.avgDurationMs) : null,
    completedCount: result?.completedCount || 0,
    failedCount: result?.failedCount || 0,
    runningCount: result?.runningCount || 0,
  };
}
