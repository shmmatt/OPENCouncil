/**
 * FileBlob and OCR storage operations (v2 pipeline)
 */

import crypto from "crypto";
import { db, schema, eq, and, asc, sql, isNull } from "./db";
import type { 
  FileBlob, 
  InsertFileBlob,
} from "@shared/schema";

// ============================================================
// FILE BLOBS
// ============================================================

export async function createFileBlob(blob: InsertFileBlob): Promise<FileBlob> {
  const [result] = await db.insert(schema.fileBlobs).values(blob).returning();
  return result;
}

export async function getFileBlobById(id: string): Promise<FileBlob | undefined> {
  const [result] = await db
    .select()
    .from(schema.fileBlobs)
    .where(eq(schema.fileBlobs.id, id));
  return result;
}

export async function getFileBlobByRawHash(rawHash: string): Promise<FileBlob | undefined> {
  const [result] = await db
    .select()
    .from(schema.fileBlobs)
    .where(eq(schema.fileBlobs.rawHash, rawHash));
  return result;
}

export async function getFileBlobByPreviewHash(previewHash: string): Promise<FileBlob | undefined> {
  const [result] = await db
    .select()
    .from(schema.fileBlobs)
    .where(eq(schema.fileBlobs.previewHash, previewHash));
  return result;
}

export async function findDuplicateBlobs(rawHash: string, previewHash?: string): Promise<{ exact: FileBlob | null; preview: FileBlob | null }> {
  const exact = await getFileBlobByRawHash(rawHash);
  let preview: FileBlob | null = null;
  
  if (!exact && previewHash) {
    const previewMatch = await getFileBlobByPreviewHash(previewHash);
    if (previewMatch) {
      preview = previewMatch;
    }
  }
  
  return { exact: exact || null, preview };
}

export async function updateFileBlob(id: string, data: Partial<InsertFileBlob>): Promise<void> {
  await db
    .update(schema.fileBlobs)
    .set(data)
    .where(eq(schema.fileBlobs.id, id));
}

// ============================================================
// OCR OPERATIONS
// ============================================================

export async function getFileBlobsNeedingOcr(): Promise<FileBlob[]> {
  return await db
    .select()
    .from(schema.fileBlobs)
    .where(and(
      eq(schema.fileBlobs.needsOcr, true),
      eq(schema.fileBlobs.ocrStatus, 'queued')
    ))
    .orderBy(asc(schema.fileBlobs.ocrQueuedAt));
}

export async function claimNextOcrJob(): Promise<FileBlob | null> {
  // Use a transaction with FOR UPDATE SKIP LOCKED for safe concurrent access
  const result = await db.execute(sql`
    UPDATE file_blobs 
    SET ocr_status = 'processing', ocr_started_at = NOW()
    WHERE id = (
      SELECT id FROM file_blobs 
      WHERE ocr_status = 'queued' 
      ORDER BY ocr_queued_at ASC NULLS LAST
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  
  if (result.rows && result.rows.length > 0) {
    const row = result.rows[0] as any;
    return {
      id: row.id,
      rawHash: row.raw_hash,
      previewHash: row.preview_hash,
      sizeBytes: row.size_bytes,
      mimeType: row.mime_type,
      originalFilename: row.original_filename,
      storagePath: row.storage_path,
      previewText: row.preview_text,
      extractedTextCharCount: row.extracted_text_char_count,
      needsOcr: row.needs_ocr,
      ocrStatus: row.ocr_status,
      ocrFailureReason: row.ocr_failure_reason,
      ocrText: row.ocr_text,
      ocrTextCharCount: row.ocr_text_char_count,
      ocrQueuedAt: row.ocr_queued_at,
      ocrStartedAt: row.ocr_started_at,
      ocrCompletedAt: row.ocr_completed_at,
      ocrReindexedAt: row.ocr_reindexed_at,
      createdAt: row.created_at,
    };
  }
  return null;
}

export async function updateOcrStatus(
  id: string, 
  status: string, 
  data?: { ocrText?: string; ocrTextCharCount?: number; ocrFailureReason?: string }
): Promise<void> {
  const updateData: any = { ocrStatus: status };
  
  if (status === 'completed' || status === 'failed') {
    updateData.ocrCompletedAt = new Date();
  }
  
  if (status === 'completed') {
    updateData.needsOcr = false;
  }
  
  if (data?.ocrText !== undefined) {
    updateData.ocrText = data.ocrText;
    if (status === 'completed' && data.ocrText) {
      updateData.previewText = data.ocrText.slice(0, 15000);
      updateData.previewHash = crypto
        .createHash('sha256')
        .update(data.ocrText)
        .digest('hex');
    }
  }
  if (data?.ocrTextCharCount !== undefined) {
    updateData.ocrTextCharCount = data.ocrTextCharCount;
  }
  if (data?.ocrFailureReason !== undefined) {
    updateData.ocrFailureReason = data.ocrFailureReason;
  }
  
  await db
    .update(schema.fileBlobs)
    .set(updateData)
    .where(eq(schema.fileBlobs.id, id));
}

export async function queueFileBlobForOcr(id: string): Promise<void> {
  await db
    .update(schema.fileBlobs)
    .set({
      needsOcr: true,
      ocrStatus: 'queued',
      ocrQueuedAt: new Date(),
      ocrFailureReason: null,
    })
    .where(eq(schema.fileBlobs.id, id));
}

export async function recoverStaleOcrJobs(staleMinutes: number = 30): Promise<number> {
  const staleThreshold = new Date(Date.now() - staleMinutes * 60 * 1000);
  
  const result = await db.execute(sql`
    UPDATE file_blobs 
    SET ocr_status = 'queued', 
        ocr_started_at = NULL,
        ocr_failure_reason = 'Recovered from stale processing state'
    WHERE ocr_status = 'processing' 
    AND ocr_started_at < ${staleThreshold}
    RETURNING id
  `);
  
  return result.rows?.length || 0;
}

export async function resetStuckProcessingJobs(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE file_blobs 
    SET ocr_status = 'queued', 
        ocr_started_at = NULL,
        ocr_failure_reason = NULL
    WHERE ocr_status = 'processing'
    RETURNING id
  `);
  
  return result.rows?.length || 0;
}

export async function getOcrCompletedNeedingReindex(): Promise<Array<{ fileBlob: FileBlob; metadata: any }>> {
  const result = await db.execute(sql`
    SELECT 
      fb.*,
      ij.final_metadata,
      ij.suggested_metadata
    FROM file_blobs fb
    JOIN ingestion_jobs ij ON ij.file_blob_id = fb.id
    WHERE fb.ocr_status = 'completed'
      AND fb.ocr_reindexed_at IS NULL
      AND fb.ocr_text IS NOT NULL
      AND ij.status = 'indexed'
    ORDER BY fb.ocr_completed_at ASC
  `);
  
  return result.rows.map((row: any) => ({
    fileBlob: {
      id: row.id,
      rawHash: row.raw_hash,
      previewHash: row.preview_hash,
      sizeBytes: row.size_bytes,
      mimeType: row.mime_type,
      originalFilename: row.original_filename,
      storagePath: row.storage_path,
      previewText: row.preview_text,
      extractedTextCharCount: row.extracted_text_char_count,
      needsOcr: row.needs_ocr,
      ocrStatus: row.ocr_status,
      ocrFailureReason: row.ocr_failure_reason,
      ocrText: row.ocr_text,
      ocrTextCharCount: row.ocr_text_char_count,
      ocrQueuedAt: row.ocr_queued_at,
      ocrStartedAt: row.ocr_started_at,
      ocrCompletedAt: row.ocr_completed_at,
      ocrReindexedAt: row.ocr_reindexed_at,
      createdAt: row.created_at,
    },
    metadata: row.final_metadata || row.suggested_metadata || {},
  }));
}

export async function markOcrReindexed(fileBlobId: string): Promise<void> {
  await db
    .update(schema.fileBlobs)
    .set({ ocrReindexedAt: new Date() })
    .where(eq(schema.fileBlobs.id, fileBlobId));
}

export async function getOcrFailedMissingFileCount(): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM file_blobs
    WHERE ocr_status = 'failed'
      AND ocr_failure_reason LIKE 'ENOENT%'
  `);
  return Number(result.rows[0]?.count || 0);
}

export async function retryOcrFailedMissingFiles(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE file_blobs
    SET ocr_status = 'queued',
        ocr_queued_at = NOW(),
        ocr_failure_reason = NULL,
        needs_ocr = true
    WHERE ocr_status = 'failed'
      AND ocr_failure_reason LIKE 'ENOENT%'
  `);
  return Number(result.rowCount || 0);
}

export async function getFileBlobsWithLocalPaths(): Promise<FileBlob[]> {
  // Get file blobs that have local storage paths (not object storage)
  const result = await db
    .select()
    .from(schema.fileBlobs)
    .where(
      and(
        sql`storage_path IS NOT NULL`,
        sql`storage_path NOT LIKE '/replit-objstore%'`,
        sql`storage_path NOT LIKE '%replit-objstore%'`
      )
    )
    .orderBy(asc(schema.fileBlobs.createdAt));
  
  return result;
}

export async function getFileBlobsNeedingOcrQueue(minCharThreshold: number): Promise<FileBlob[]> {
  return await db
    .select()
    .from(schema.fileBlobs)
    .where(
      and(
        sql`extracted_text_char_count < ${minCharThreshold}`,
        eq(schema.fileBlobs.ocrStatus, 'none'),
        eq(schema.fileBlobs.needsOcr, false)
      )
    )
    .orderBy(asc(schema.fileBlobs.createdAt));
}

export async function getOcrQueueStats(): Promise<{
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  blocked: number;
}> {
  const result = await db.execute(sql`
    SELECT 
      ocr_status,
      COUNT(*) as count
    FROM file_blobs
    WHERE needs_ocr = true OR ocr_status != 'none'
    GROUP BY ocr_status
  `);
  
  const stats = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
  };
  
  for (const row of result.rows as any[]) {
    const status = row.ocr_status as keyof typeof stats;
    if (status in stats) {
      stats[status] = Number(row.count);
    }
  }
  
  return stats;
}
