/**
 * S3 Gemini Sync storage operations
 * Tracks files synced from S3 to Gemini File Search stores
 */

import { db, schema, eq, and, sql } from "./db";
import type { S3GeminiSync, InsertS3GeminiSync, S3SyncStatus } from "@shared/schema";

// ============================================================
// CRUD OPERATIONS
// ============================================================

export async function createS3GeminiSync(record: InsertS3GeminiSync): Promise<S3GeminiSync> {
  const [result] = await db.insert(schema.s3GeminiSync).values(record).returning();
  return result;
}

export async function getS3GeminiSyncByS3Key(s3Key: string): Promise<S3GeminiSync | undefined> {
  const [result] = await db
    .select()
    .from(schema.s3GeminiSync)
    .where(eq(schema.s3GeminiSync.s3Key, s3Key));
  return result;
}

export async function getS3GeminiSyncById(id: string): Promise<S3GeminiSync | undefined> {
  const [result] = await db
    .select()
    .from(schema.s3GeminiSync)
    .where(eq(schema.s3GeminiSync.id, id));
  return result;
}

export async function updateS3GeminiSync(
  id: string, 
  data: Partial<InsertS3GeminiSync>
): Promise<void> {
  await db
    .update(schema.s3GeminiSync)
    .set(data)
    .where(eq(schema.s3GeminiSync.id, id));
}

export async function markSynced(
  id: string, 
  geminiDocumentId: string
): Promise<void> {
  await db
    .update(schema.s3GeminiSync)
    .set({
      status: 'synced',
      geminiDocumentId,
      syncedAt: new Date(),
      errorMessage: null,
    })
    .where(eq(schema.s3GeminiSync.id, id));
}

export async function markFailed(
  id: string, 
  errorMessage: string
): Promise<void> {
  await db
    .update(schema.s3GeminiSync)
    .set({
      status: 'failed',
      errorMessage,
    })
    .where(eq(schema.s3GeminiSync.id, id));
}

// ============================================================
// QUERY OPERATIONS
// ============================================================

export async function getSyncedS3Keys(town?: string): Promise<Set<string>> {
  const query = db
    .select({ s3Key: schema.s3GeminiSync.s3Key })
    .from(schema.s3GeminiSync)
    .where(
      town 
        ? and(
            eq(schema.s3GeminiSync.status, 'synced'),
            eq(schema.s3GeminiSync.town, town.toLowerCase())
          )
        : eq(schema.s3GeminiSync.status, 'synced')
    );
  
  const results = await query;
  return new Set(results.map(r => r.s3Key));
}

export async function getPendingS3Keys(town?: string): Promise<S3GeminiSync[]> {
  const query = db
    .select()
    .from(schema.s3GeminiSync)
    .where(
      town 
        ? and(
            eq(schema.s3GeminiSync.status, 'pending'),
            eq(schema.s3GeminiSync.town, town.toLowerCase())
          )
        : eq(schema.s3GeminiSync.status, 'pending')
    );
  
  return await query;
}

export async function getSyncStats(town?: string): Promise<{
  total: number;
  synced: number;
  pending: number;
  failed: number;
}> {
  const whereClause = town 
    ? eq(schema.s3GeminiSync.town, town.toLowerCase())
    : sql`1=1`;
  
  const result = await db.execute(sql`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'synced') as synced,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM s3_gemini_sync
    WHERE ${whereClause}
  `);
  
  const row = result.rows[0] as any;
  return {
    total: Number(row?.total || 0),
    synced: Number(row?.synced || 0),
    pending: Number(row?.pending || 0),
    failed: Number(row?.failed || 0),
  };
}

export async function getOrCreateSyncRecord(
  s3Key: string,
  data: Omit<InsertS3GeminiSync, 's3Key'>
): Promise<S3GeminiSync> {
  const existing = await getS3GeminiSyncByS3Key(s3Key);
  if (existing) return existing;
  
  return await createS3GeminiSync({
    s3Key,
    ...data,
  });
}

// ============================================================
// BULK OPERATIONS
// ============================================================

export async function upsertSyncRecords(
  records: InsertS3GeminiSync[]
): Promise<number> {
  if (records.length === 0) return 0;
  
  // Use ON CONFLICT to upsert
  const result = await db
    .insert(schema.s3GeminiSync)
    .values(records)
    .onConflictDoNothing({ target: schema.s3GeminiSync.s3Key })
    .returning({ id: schema.s3GeminiSync.id });
  
  return result.length;
}

export async function resetFailedSyncs(town?: string): Promise<number> {
  const result = await db.execute(sql`
    UPDATE s3_gemini_sync 
    SET status = 'pending', error_message = NULL
    WHERE status = 'failed'
    ${town ? sql`AND town = ${town.toLowerCase()}` : sql``}
    RETURNING id
  `);
  
  return result.rows?.length || 0;
}
