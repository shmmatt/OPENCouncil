import { db, schema, eq, sql } from "./db";
import type { OcrJob, InsertOcrJob } from "@shared/schema";

function mapRowToOcrJob(row: any): OcrJob {
  return {
    id: row.id,
    documentId: row.document_id,
    fileBlobId: row.file_blob_id,
    status: row.status,
    priority: row.priority,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    availableAt: row.available_at,
    attempts: row.attempts,
    lastError: row.last_error,
    pageCount: row.page_count,
    nativeTextChars: row.native_text_chars,
    isPdf: row.is_pdf,
    textractJobId: row.textract_job_id,
    textractStartedAt: row.textract_started_at,
    textractCompletedAt: row.textract_completed_at,
    textractNextToken: row.textract_next_token,
    s3Bucket: row.s3_bucket,
    s3Key: row.s3_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createOcrJob(job: InsertOcrJob): Promise<OcrJob> {
  const [result] = await db.insert(schema.ocrJobs).values(job).returning();
  return result;
}

export async function getOcrJobById(id: number): Promise<OcrJob | undefined> {
  const [result] = await db
    .select()
    .from(schema.ocrJobs)
    .where(eq(schema.ocrJobs.id, id));
  return result;
}

export async function getOcrJobByDocumentId(documentId: string): Promise<OcrJob | undefined> {
  const [result] = await db
    .select()
    .from(schema.ocrJobs)
    .where(eq(schema.ocrJobs.documentId, documentId));
  return result;
}

export async function claimOcrJob(
  statuses: string[],
  workerId: string
): Promise<OcrJob | null> {
  const statusList = statuses.map((s) => `'${s}'`).join(",");
  const result = await db.execute(sql`
    UPDATE ocr_jobs
    SET locked_by = ${workerId},
        locked_at = NOW(),
        updated_at = NOW()
    WHERE id = (
      SELECT id FROM ocr_jobs
      WHERE status IN (${sql.raw(statusList)})
        AND available_at <= NOW()
        AND (locked_by IS NULL OR locked_at < NOW() - INTERVAL '10 minutes')
      ORDER BY priority DESC, available_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  if (result.rows && result.rows.length > 0) {
    return mapRowToOcrJob(result.rows[0]);
  }
  return null;
}

export async function updateOcrJob(
  id: number,
  data: Partial<{
    status: string;
    lockedBy: string | null;
    lockedAt: Date | null;
    availableAt: Date;
    attempts: number;
    lastError: string | null;
    pageCount: number;
    nativeTextChars: number;
    isPdf: boolean;
    textractJobId: string;
    textractStartedAt: Date;
    textractCompletedAt: Date;
    textractNextToken: string | null;
  }>
): Promise<void> {
  const updateData: any = { ...data, updatedAt: new Date() };
  await db
    .update(schema.ocrJobs)
    .set(updateData)
    .where(eq(schema.ocrJobs.id, id));
}

export async function releaseOcrJob(id: number): Promise<void> {
  await updateOcrJob(id, { lockedBy: null, lockedAt: null });
}

export async function getOcrJobStats(): Promise<{
  queued: number;
  skipped_native: number;
  textract_running: number;
  textract_failed: number;
  materialized: number;
  failed: number;
}> {
  const result = await db.execute(sql`
    SELECT status, COUNT(*) as count
    FROM ocr_jobs
    GROUP BY status
  `);

  const stats: any = {
    queued: 0,
    skipped_native: 0,
    textract_running: 0,
    textract_failed: 0,
    materialized: 0,
    failed: 0,
  };

  for (const row of result.rows as any[]) {
    if (row.status in stats) {
      stats[row.status] = Number(row.count);
    }
  }

  return stats;
}

export async function getOcrJobsByStatus(status: string): Promise<OcrJob[]> {
  return await db
    .select()
    .from(schema.ocrJobs)
    .where(eq(schema.ocrJobs.status, status));
}

export async function resetStuckOcrJobs(staleMinutes: number = 15): Promise<number> {
  const result = await db.execute(sql`
    UPDATE ocr_jobs
    SET locked_by = NULL,
        locked_at = NULL,
        updated_at = NOW()
    WHERE locked_by IS NOT NULL
      AND locked_at < NOW() - ${staleMinutes.toString() + ' minutes'}::INTERVAL
      AND status NOT IN ('materialized', 'failed', 'skipped_native')
    RETURNING id
  `);
  return result.rows?.length || 0;
}

export async function retryFailedOcrJobs(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE ocr_jobs
    SET status = 'queued',
        locked_by = NULL,
        locked_at = NULL,
        last_error = NULL,
        attempts = 0,
        available_at = NOW(),
        updated_at = NOW()
    WHERE status IN ('failed', 'textract_failed')
    RETURNING id
  `);
  return result.rows?.length || 0;
}

export async function getAllOcrJobs(
  limit: number = 100,
  offset: number = 0,
  statusFilter?: string
): Promise<{ jobs: OcrJob[]; total: number }> {
  const countResult = await db.execute(
    statusFilter
      ? sql`SELECT COUNT(*) as count FROM ocr_jobs WHERE status = ${statusFilter}`
      : sql`SELECT COUNT(*) as count FROM ocr_jobs`
  );
  const total = Number((countResult.rows[0] as any)?.count || 0);

  const jobsResult = await db.execute(
    statusFilter
      ? sql`SELECT * FROM ocr_jobs WHERE status = ${statusFilter} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
      : sql`SELECT * FROM ocr_jobs ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  );

  const jobs = (jobsResult.rows as any[]).map(mapRowToOcrJob);
  return { jobs, total };
}

export async function getTrackedS3Keys(): Promise<Set<string>> {
  const result = await db.execute(sql`SELECT s3_key FROM ocr_jobs WHERE s3_key IS NOT NULL`);
  return new Set((result.rows as any[]).map((r) => r.s3_key));
}

export async function enqueueDocumentsForOcr(
  documents: Array<{
    documentId: string;
    fileBlobId?: string;
    s3Bucket: string;
    s3Key: string;
    priority?: number;
  }>
): Promise<number> {
  let enqueued = 0;
  for (const doc of documents) {
    const existing = await getOcrJobByDocumentId(doc.documentId);
    if (existing) continue;

    await createOcrJob({
      documentId: doc.documentId,
      fileBlobId: doc.fileBlobId || null,
      status: "queued",
      priority: doc.priority || 0,
      s3Bucket: doc.s3Bucket,
      s3Key: doc.s3Key,
      availableAt: new Date(),
      attempts: 0,
    });
    enqueued++;
  }
  return enqueued;
}
