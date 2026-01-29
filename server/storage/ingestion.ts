/**
 * Ingestion job storage operations (v2 pipeline)
 */

import { db, schema, eq, desc } from "./db";
import type { 
  IngestionJob, 
  InsertIngestionJob,
  IngestionJobStatus,
  IngestionJobWithBlob,
} from "@shared/schema";

// ============================================================
// INGESTION JOBS
// ============================================================

export async function createIngestionJob(job: InsertIngestionJob): Promise<IngestionJob> {
  const [result] = await db.insert(schema.ingestionJobs).values(job).returning();
  return result;
}

export async function getIngestionJobById(id: string): Promise<IngestionJob | undefined> {
  const [result] = await db
    .select()
    .from(schema.ingestionJobs)
    .where(eq(schema.ingestionJobs.id, id));
  return result;
}

export async function getIngestionJobWithBlob(id: string): Promise<IngestionJobWithBlob | undefined> {
  const [result] = await db
    .select({
      job: schema.ingestionJobs,
      fileBlob: schema.fileBlobs,
    })
    .from(schema.ingestionJobs)
    .innerJoin(schema.fileBlobs, eq(schema.ingestionJobs.fileBlobId, schema.fileBlobs.id))
    .where(eq(schema.ingestionJobs.id, id));

  if (!result) return undefined;

  return {
    ...result.job,
    fileBlob: result.fileBlob,
  };
}

export async function getIngestionJobsByStatus(status: IngestionJobStatus): Promise<IngestionJobWithBlob[]> {
  const results = await db
    .select({
      job: schema.ingestionJobs,
      fileBlob: schema.fileBlobs,
    })
    .from(schema.ingestionJobs)
    .innerJoin(schema.fileBlobs, eq(schema.ingestionJobs.fileBlobId, schema.fileBlobs.id))
    .where(eq(schema.ingestionJobs.status, status))
    .orderBy(desc(schema.ingestionJobs.createdAt));

  return results.map(r => ({
    ...r.job,
    fileBlob: r.fileBlob,
  }));
}

export async function getAllIngestionJobs(): Promise<IngestionJobWithBlob[]> {
  const results = await db
    .select({
      job: schema.ingestionJobs,
      fileBlob: schema.fileBlobs,
    })
    .from(schema.ingestionJobs)
    .innerJoin(schema.fileBlobs, eq(schema.ingestionJobs.fileBlobId, schema.fileBlobs.id))
    .orderBy(desc(schema.ingestionJobs.createdAt));

  return results.map(r => ({
    ...r.job,
    fileBlob: r.fileBlob,
  }));
}

export async function updateIngestionJob(id: string, data: Partial<InsertIngestionJob>): Promise<void> {
  await db
    .update(schema.ingestionJobs)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.ingestionJobs.id, id));
}

export async function deleteIngestionJob(id: string): Promise<void> {
  await db.delete(schema.ingestionJobs).where(eq(schema.ingestionJobs.id, id));
}

/**
 * Get ingestion metadata for a file blob by fileBlobId.
 * Used by OCR worker to reindex documents after OCR completion.
 */
export async function getIngestionMetadataForFileBlob(fileBlobId: string): Promise<{
  jobId: string;
  isIndexed: boolean;
  metadata: Record<string, unknown>;
} | null> {
  const [result] = await db
    .select()
    .from(schema.ingestionJobs)
    .where(eq(schema.ingestionJobs.fileBlobId, fileBlobId));
  
  if (!result) {
    return null;
  }
  
  const isIndexed = result.status === 'indexed';
  const metadata = (result.finalMetadata || result.suggestedMetadata || {}) as Record<string, unknown>;
  
  return {
    jobId: result.id,
    isIndexed,
    metadata,
  };
}
