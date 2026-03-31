import { db, sql } from "../storage/db";
import { generateEmbeddingBatch } from "./embeddingService";
import { logInfo, logError } from "../utils/logger";
import * as crypto from "crypto";

const CHUNK_TARGET_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 200;
const EMBEDDING_BATCH_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 1200;

const UUID_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.pdf)?$/i;

/**
 * Builds a metadata context header to prepend to chunk text at embedding time.
 * Stored content stays clean; only the vector captures these enriched terms.
 * Format differs by source type: town, statewide, or SAU.
 */
export function buildContextHeader(params: {
  town?: string | null;
  sau?: string | null;
  sourceType?: string | null;
  board?: string | null;
  documentType?: string | null;
  year?: string | null;
  filename?: string | null;
}): string {
  const { town, sau, sourceType, board, documentType, year, filename } = params;
  const parts: string[] = [];

  const isStatewide = town === "statewide" || sourceType === "state";
  const isSau = !!(sau && sau.trim()) || sourceType === "sau";
  const cleanFilename = filename && !UUID_FILENAME_RE.test(filename) ? filename : null;

  if (isStatewide) {
    parts.push("Scope: NH Statewide");
    if (board) parts.push(`Agency: ${board}`);
    if (documentType && documentType !== "general") parts.push(`Type: ${documentType.replace(/_/g, " ")}`);
    if (year) parts.push(`Year: ${year}`);
    if (cleanFilename) parts.push(`File: ${cleanFilename}`);
  } else if (isSau) {
    if (sau) parts.push(`District: ${sau}`);
    if (board) parts.push(`Board: ${board}`);
    if (documentType && documentType !== "general") parts.push(`Type: ${documentType.replace(/_/g, " ")}`);
    if (year) parts.push(`Year: ${year}`);
  } else {
    if (town && town !== "unknown") parts.push(`Town: ${town}`);
    if (board) parts.push(`Board: ${board}`);
    if (documentType && documentType !== "general") parts.push(`Type: ${documentType.replace(/_/g, " ")}`);
    if (year) parts.push(`Year: ${year}`);
    if (cleanFilename) parts.push(`File: ${cleanFilename}`);
  }

  if (parts.length === 0) return "";
  return `[${parts.join(" | ")}]`;
}

interface ChunkData {
  fileBlobId: string;
  documentId: string | null;
  chunkIndex: number;
  content: string;
  town: string;
  category: string;
  board: string | null;
  year: string | null;
  contentHash: string;
  filename: string | null;
  sau: string | null;
  sourceType: string | null;
}

export interface PipelineProgress {
  status: "idle" | "running" | "stopping" | "completed" | "failed";
  totalDocuments: number;
  processedDocuments: number;
  totalChunks: number;
  insertedChunks: number;
  errorCount: number;
  errors: string[];
  startedAt: string | null;
  completedAt: string | null;
  batchId: string | null;
  currentDocument: string | null;
  estimatedTimeRemaining: number | null;
}

let currentProgress: PipelineProgress = makeIdleProgress();
let stopRequested = false;

function makeIdleProgress(): PipelineProgress {
  return {
    status: "idle",
    totalDocuments: 0,
    processedDocuments: 0,
    totalChunks: 0,
    insertedChunks: 0,
    errorCount: 0,
    errors: [],
    startedAt: null,
    completedAt: null,
    batchId: null,
    currentDocument: null,
    estimatedTimeRemaining: null,
  };
}

export function getProgress(): PipelineProgress {
  return { ...currentProgress };
}

export function requestStop(): boolean {
  if (currentProgress.status === "running") {
    stopRequested = true;
    currentProgress.status = "stopping";
    return true;
  }
  return false;
}

export function isRunning(): boolean {
  return currentProgress.status === "running" || currentProgress.status === "stopping";
}

function chunkText(text: string): { index: number; content: string }[] {
  if (!text || text.trim().length === 0) return [];

  const chunks: { index: number; content: string }[] = [];
  let position = 0;
  let chunkIndex = 0;

  while (position < text.length) {
    let endPos = Math.min(position + CHUNK_TARGET_CHARS, text.length);

    if (endPos < text.length) {
      const searchStart = Math.max(position + CHUNK_TARGET_CHARS - 400, position);
      const searchEnd = Math.min(position + CHUNK_TARGET_CHARS + 200, text.length);
      const searchRegion = text.slice(searchStart, searchEnd);
      const sentenceEnd = searchRegion.search(/[.!?]\s/);
      if (sentenceEnd !== -1) {
        endPos = searchStart + sentenceEnd + 1;
      } else {
        const paragraphBreak = searchRegion.indexOf("\n\n");
        if (paragraphBreak !== -1) {
          endPos = searchStart + paragraphBreak;
        }
      }
    }

    const chunkContent = text.slice(position, endPos).trim();
    if (chunkContent.length > 0) {
      chunks.push({ index: chunkIndex, content: chunkContent });
      chunkIndex++;
    }

    if (endPos >= text.length) break;
    position = endPos - CHUNK_OVERLAP_CHARS;
    if (position <= 0 || (chunks.length > 1 && position <= chunks[chunks.length - 2].index)) {
      position = endPos;
    }
  }

  return chunks;
}

interface FileBlobRow {
  id: string;
  preview_text: string | null;
  ocr_text: string | null;
  original_filename: string;
  content_hash: string | null;
  town: string | null;
  board: string | null;
  category: string | null;
  year: string | null;
  document_id: string | null;
  sau: string | null;
  source_type: string | null;
}

async function fetchReadyBlobs(limit: number | null, town: string | null): Promise<FileBlobRow[]> {
  let finalQuery = `
    SELECT 
      fb.id,
      fb.preview_text,
      fb.ocr_text,
      fb.original_filename,
      fb.content_hash,
      COALESCE(ld.town, ct.name) as town,
      COALESCE(ld.board, cd.board) as board,
      ld.category,
      dv.year,
      dv.document_id,
      css.sau_id as sau,
      CASE
        WHEN csd.id IS NOT NULL THEN 'sau'
        WHEN cssd.id IS NOT NULL THEN 'state'
        WHEN cd.id IS NOT NULL THEN 'town'
        ELSE 'unknown'
      END as source_type
    FROM file_blobs fb
    LEFT JOIN document_versions dv ON dv.file_blob_id = fb.id AND dv.is_current = true
    LEFT JOIN logical_documents ld ON dv.document_id = ld.id
    LEFT JOIN crawler_documents cd ON cd.file_blob_id = fb.id
    LEFT JOIN crawler_towns ct ON cd.town_id = ct.id
    LEFT JOIN crawler_sau_documents csd ON csd.file_blob_id = fb.id
    LEFT JOIN crawler_sau_sources css ON csd.source_id = css.id
    LEFT JOIN crawler_state_documents cssd ON cssd.file_blob_id = fb.id
    WHERE fb.embedding_status = 'none'
      AND (fb.ocr_text IS NOT NULL OR fb.preview_text IS NOT NULL)
      AND (COALESCE(char_length(fb.ocr_text), 0) + COALESCE(char_length(fb.preview_text), 0)) > 100
  `;

  if (town) {
    finalQuery += ` AND LOWER(COALESCE(ld.town, ct.name, 'unknown')) = LOWER('${town.replace(/'/g, "''")}')`;
  }
  finalQuery += ` ORDER BY COALESCE(ld.town, ct.name, 'zzz'), fb.original_filename`;
  if (limit) {
    finalQuery += ` LIMIT ${limit}`;
  }

  const result = await db.execute(sql.raw(finalQuery));
  return (result.rows || result) as unknown as FileBlobRow[];
}

async function fetchBlobsByIds(blobIds: string[]): Promise<FileBlobRow[]> {
  if (blobIds.length === 0) return [];
  const idPlaceholders = sql.join(blobIds.map(id => sql`${id}`), sql`, `);
  const result = await db.execute(sql`
    SELECT 
      fb.id,
      fb.preview_text,
      fb.ocr_text,
      fb.original_filename,
      fb.content_hash,
      COALESCE(ld.town, ct.name) as town,
      COALESCE(ld.board, cd.board) as board,
      ld.category,
      dv.year,
      dv.document_id,
      css.sau_id as sau,
      CASE
        WHEN csd.id IS NOT NULL THEN 'sau'
        WHEN cssd.id IS NOT NULL THEN 'state'
        WHEN cd.id IS NOT NULL THEN 'town'
        ELSE 'unknown'
      END as source_type
    FROM file_blobs fb
    LEFT JOIN document_versions dv ON dv.file_blob_id = fb.id AND dv.is_current = true
    LEFT JOIN logical_documents ld ON dv.document_id = ld.id
    LEFT JOIN crawler_documents cd ON cd.file_blob_id = fb.id
    LEFT JOIN crawler_towns ct ON cd.town_id = ct.id
    LEFT JOIN crawler_sau_documents csd ON csd.file_blob_id = fb.id
    LEFT JOIN crawler_sau_sources css ON csd.source_id = css.id
    LEFT JOIN crawler_state_documents cssd ON cssd.file_blob_id = fb.id
    WHERE fb.id IN (${idPlaceholders})
      AND fb.embedding_status != 'indexed'
      AND (fb.ocr_text IS NOT NULL OR fb.preview_text IS NOT NULL)
    ORDER BY fb.original_filename
  `);
  return (result.rows || result) as unknown as FileBlobRow[];
}

async function insertChunk(c: ChunkData & { embedding: number[] }): Promise<void> {
  const metadataJson = JSON.stringify({
    town: c.town || undefined,
    board: c.board || undefined,
    year: c.year || undefined,
    documentType: c.category || undefined,
    filename: c.filename || undefined,
    fileBlobId: c.fileBlobId,
    contentHash: c.contentHash,
    sau: c.sau || undefined,
    sourceType: c.sourceType || undefined,
  });
  const embeddingStr = `[${c.embedding.join(",")}]`;

  await db.execute(sql`
    INSERT INTO document_chunks (document_id, file_blob_id, chunk_index, content, embedding, metadata)
    VALUES (${c.documentId || null}, ${c.fileBlobId}, ${c.chunkIndex}, ${c.content}, ${embeddingStr}::vector, ${metadataJson}::jsonb)
  `);
}

async function updateBlobIndexed(blobId: string, chunkCount: number): Promise<void> {
  await db.execute(sql`
    UPDATE file_blobs 
    SET embedding_status = 'indexed', 
        chunk_count = ${chunkCount}, 
        embedded_at = NOW(),
        content_hash = COALESCE(content_hash, md5(COALESCE(ocr_text, preview_text)))
    WHERE id = ${blobId}
  `);
}

export async function startPipeline(options?: { limit?: number; town?: string; blobIds?: string[] }): Promise<void> {
  if (isRunning()) {
    throw new Error("Pipeline is already running");
  }

  stopRequested = false;
  const batchId = `embed-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;

  currentProgress = {
    ...makeIdleProgress(),
    status: "running",
    startedAt: new Date().toISOString(),
    batchId,
  };

  try {
    logInfo(`[embeddingPipeline] Starting pipeline run ${batchId}`);

    let blobs: FileBlobRow[];
    if (options?.blobIds && options.blobIds.length > 0) {
      blobs = await fetchBlobsByIds(options.blobIds);
    } else {
      blobs = await fetchReadyBlobs(options?.limit || null, options?.town || null);
    }
    currentProgress.totalDocuments = blobs.length;
    logInfo(`[embeddingPipeline] Found ${blobs.length} file_blobs ready for embedding`);

    if (blobs.length === 0) {
      currentProgress.status = "completed";
      currentProgress.completedAt = new Date().toISOString();
      return;
    }

    await db.execute(sql`
      INSERT INTO embedding_jobs (batch_id, status, file_blobs_processed, chunks_count, started_at)
      VALUES (${batchId}, 'running', 0, 0, NOW())
    `);

    const blobChunkCounts: Record<string, number> = {};
    const startTime = Date.now();
    let pendingChunks: ChunkData[] = [];

    for (const blob of blobs) {
      if (stopRequested) {
        logInfo("[embeddingPipeline] Stop requested, finishing current batch...");
        break;
      }

      const text = blob.ocr_text || blob.preview_text;
      if (!text || text.trim().length < 100) {
        currentProgress.processedDocuments++;
        continue;
      }

      const textChunks = chunkText(text);
      if (textChunks.length === 0) {
        currentProgress.processedDocuments++;
        continue;
      }

      const contentHash = blob.content_hash || crypto.createHash("md5").update(text).digest("hex");
      currentProgress.currentDocument = blob.original_filename || blob.id;

      for (const chunk of textChunks) {
        pendingChunks.push({
          fileBlobId: blob.id,
          documentId: blob.document_id || null,
          chunkIndex: chunk.index,
          content: chunk.content,
          town: blob.town || "unknown",
          category: blob.category || "general",
          board: blob.board || null,
          year: blob.year || null,
          contentHash,
          filename: blob.original_filename || null,
          sau: blob.sau || null,
          sourceType: blob.source_type || null,
        });
      }

      currentProgress.totalChunks += textChunks.length;
      blobChunkCounts[blob.id] = textChunks.length;

      if (pendingChunks.length >= EMBEDDING_BATCH_SIZE) {
        const batchToProcess = pendingChunks.splice(0, EMBEDDING_BATCH_SIZE);
        await processBatch(batchToProcess);
      }

      currentProgress.processedDocuments++;

      if (currentProgress.processedDocuments > 2 && currentProgress.processedDocuments % 5 === 0) {
        const elapsed = Date.now() - startTime;
        const rate = currentProgress.processedDocuments / (elapsed / 1000);
        const remaining = currentProgress.totalDocuments - currentProgress.processedDocuments;
        currentProgress.estimatedTimeRemaining = Math.round(remaining / rate);
      }
    }

    if (pendingChunks.length > 0 && !stopRequested) {
      await processBatch(pendingChunks);
    }

    const blobIds = Object.keys(blobChunkCounts);
    for (const blobId of blobIds) {
      try {
        await updateBlobIndexed(blobId, blobChunkCounts[blobId]);
      } catch (err: any) {
        logError(`[embeddingPipeline] Failed to update blob ${blobId}: ${err.message}`);
      }
    }

    const finalStatus = stopRequested ? "stopped" : "completed";
    await db.execute(sql`
      UPDATE embedding_jobs 
      SET status = ${finalStatus}, 
          chunks_count = ${currentProgress.insertedChunks}, 
          file_blobs_processed = ${currentProgress.processedDocuments}, 
          completed_at = NOW() 
      WHERE batch_id = ${batchId}
    `);

    currentProgress.status = "completed";
    currentProgress.completedAt = new Date().toISOString();
    currentProgress.currentDocument = null;

    logInfo(`[embeddingPipeline] Pipeline ${finalStatus}: ${currentProgress.processedDocuments} docs, ${currentProgress.insertedChunks} chunks, ${currentProgress.errorCount} errors`);
  } catch (error: any) {
    logError(`[embeddingPipeline] Pipeline failed: ${error.message}`);
    currentProgress.status = "failed";
    currentProgress.completedAt = new Date().toISOString();
    currentProgress.errors.push(error.message || "Unknown error");

    await db.execute(sql`
      UPDATE embedding_jobs 
      SET status = 'failed', 
          error = ${error.message || "Unknown error"},
          chunks_count = ${currentProgress.insertedChunks}, 
          file_blobs_processed = ${currentProgress.processedDocuments}, 
          completed_at = NOW() 
      WHERE batch_id = ${batchId}
    `).catch(() => {});
  }
}

async function processBatch(chunks: ChunkData[]): Promise<void> {
  try {
    const texts = chunks.map(c => {
      const header = buildContextHeader({
        town: c.town,
        sau: c.sau,
        sourceType: c.sourceType,
        board: c.board,
        documentType: c.category,
        year: c.year,
        filename: c.filename,
      });
      return header ? `${header}\n\n${c.content}` : c.content;
    });
    const embeddings = await generateEmbeddingBatch(texts);

    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`);
    }

    for (let i = 0; i < chunks.length; i++) {
      try {
        await insertChunk({ ...chunks[i], embedding: embeddings[i] });
        currentProgress.insertedChunks++;
      } catch (err: any) {
        logError(`[embeddingPipeline] Failed to insert chunk: ${err.message}`);
        currentProgress.errorCount++;
        if (currentProgress.errors.length < 20) {
          currentProgress.errors.push(`Insert failed for blob ${chunks[i].fileBlobId} chunk ${chunks[i].chunkIndex}: ${err.message}`);
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
  } catch (error: any) {
    logError(`[embeddingPipeline] Batch embedding failed: ${error.message}`);
    currentProgress.errorCount += chunks.length;
    if (currentProgress.errors.length < 20) {
      currentProgress.errors.push(`Batch of ${chunks.length} chunks failed: ${error.message}`);
    }

    if (error.message?.includes("429") || error.message?.includes("quota") || error.message?.includes("rate")) {
      logInfo("[embeddingPipeline] Rate limited, waiting 30 seconds...");
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
}

// ─── Re-embed (Reindex) Infrastructure ───────────────────────────────────────

export type ReindexScope = "town" | "state" | "sau" | "all";

export interface ReindexProgress {
  status: "idle" | "running" | "stopping" | "completed" | "stopped" | "failed";
  scope: ReindexScope | null;
  townFilter: string | null;
  totalChunks: number;
  processedChunks: number;
  errorCount: number;
  errors: string[];
  startedAt: string | null;
  completedAt: string | null;
  jobId: string | null;
  estimatedTimeRemaining: number | null;
}

function makeIdleReindexProgress(): ReindexProgress {
  return {
    status: "idle",
    scope: null,
    townFilter: null,
    totalChunks: 0,
    processedChunks: 0,
    errorCount: 0,
    errors: [],
    startedAt: null,
    completedAt: null,
    jobId: null,
    estimatedTimeRemaining: null,
  };
}

let reindexProgress: ReindexProgress = makeIdleReindexProgress();
let reindexStopRequested = false;

export function getReindexProgress(): ReindexProgress {
  return { ...reindexProgress };
}

export function isReindexRunning(): boolean {
  return reindexProgress.status === "running" || reindexProgress.status === "stopping";
}

export function requestReindexStop(): boolean {
  if (reindexProgress.status === "running") {
    reindexStopRequested = true;
    reindexProgress.status = "stopping";
    return true;
  }
  return false;
}

function buildReindexWhereClause(
  scope: ReindexScope,
  townFilter: string | null,
  blobIds?: string[] | null,
): string {
  if (blobIds && blobIds.length > 0) {
    const safeIds = blobIds.map(id => `'${id.replace(/'/g, "''")}'`).join(", ");
    return `WHERE file_blob_id IN (${safeIds})`;
  }
  const conditions: string[] = [];
  if (scope === "town") {
    conditions.push(`(metadata->>'town' IS DISTINCT FROM 'statewide')`);
    conditions.push(`(metadata->>'sau' IS NULL OR metadata->>'sau' = '')`);
  } else if (scope === "state") {
    conditions.push(`(metadata->>'town' = 'statewide' OR metadata->>'sourceType' = 'state')`);
  } else if (scope === "sau") {
    conditions.push(`(metadata->>'sau' IS NOT NULL AND metadata->>'sau' != '')`);
  }
  if (townFilter) {
    const safe = townFilter.replace(/'/g, "''");
    conditions.push(`lower(metadata->>'town') = lower('${safe}')`);
  }
  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

/**
 * Count chunks that will be reindexed given the scope/filter.
 */
async function countReindexChunks(
  scope: ReindexScope,
  townFilter: string | null,
  blobIds?: string[] | null,
): Promise<number> {
  const whereClause = buildReindexWhereClause(scope, townFilter, blobIds);
  const result = await db.execute(sql.raw(`SELECT count(*)::int AS cnt FROM document_chunks ${whereClause}`));
  const rows = (result.rows || result) as any[];
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Fetch a batch of chunks for reindexing using cursor pagination.
 */
async function fetchReindexBatch(
  lastId: number,
  scope: ReindexScope,
  townFilter: string | null,
  batchSize: number,
  blobIds?: string[] | null,
): Promise<{ id: number; content: string; metadata: Record<string, any> }[]> {
  const whereClause = buildReindexWhereClause(scope, townFilter, blobIds);
  const andOrWhere = whereClause ? `${whereClause} AND id > ${lastId}` : `WHERE id > ${lastId}`;
  const result = await db.execute(
    sql.raw(`SELECT id, content, metadata FROM document_chunks ${andOrWhere} ORDER BY id LIMIT ${batchSize}`)
  );
  return (result.rows || result) as any[];
}

/**
 * Re-embed all existing chunks that match the given scope/filter or explicit blobIds.
 * Accepts: scope, town (alias for townFilter), sourceType (maps to scope), blobIds.
 * Runs as a background job; poll getReindexProgress() for status.
 */
export async function startReindex(options?: {
  scope?: ReindexScope;
  townFilter?: string;
  town?: string;
  sourceType?: string;
  blobIds?: string[];
}): Promise<void> {
  if (isReindexRunning()) {
    throw new Error("Reindex is already running");
  }

  const sourceTypeToScope: Record<string, ReindexScope> = {
    town: "town", state: "state", sau: "sau",
  };
  const resolvedScope: ReindexScope =
    options?.scope ??
    (options?.sourceType ? sourceTypeToScope[options.sourceType] ?? "all" : "all");
  const townFilter = options?.town ?? options?.townFilter ?? null;
  const blobIds = options?.blobIds && options.blobIds.length > 0 ? options.blobIds : null;
  const jobId = `reindex-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;

  reindexStopRequested = false;
  reindexProgress = {
    ...makeIdleReindexProgress(),
    status: "running",
    scope: resolvedScope,
    townFilter,
    jobId,
    startedAt: new Date().toISOString(),
  };

  try {
    logInfo(`[embeddingPipeline] Reindex ${jobId} started (scope=${resolvedScope}, town=${townFilter ?? "all"}${blobIds ? `, blobIds=${blobIds.length}` : ""})`);

    const totalChunks = await countReindexChunks(resolvedScope, townFilter, blobIds);
    reindexProgress.totalChunks = totalChunks;
    logInfo(`[embeddingPipeline] Reindex: ${totalChunks} chunks to re-embed`);

    if (totalChunks === 0) {
      reindexProgress.status = "completed";
      reindexProgress.completedAt = new Date().toISOString();
      return;
    }

    let lastId = 0;
    const startTime = Date.now();

    while (!reindexStopRequested) {
      const rows = await fetchReindexBatch(lastId, resolvedScope, townFilter, EMBEDDING_BATCH_SIZE, blobIds);
      if (rows.length === 0) break;

      const texts = rows.map(row => {
        const meta = row.metadata ?? {};
        const header = buildContextHeader({
          town: meta.town,
          sau: meta.sau,
          sourceType: meta.sourceType,
          board: meta.board,
          documentType: meta.documentType,
          year: meta.year,
          filename: meta.filename,
        });
        return header ? `${header}\n\n${row.content}` : row.content;
      });

      try {
        const embeddings = await generateEmbeddingBatch(texts);
        if (embeddings.length !== rows.length) {
          throw new Error(`Reindex embedding count mismatch: expected ${rows.length}, got ${embeddings.length}`);
        }

        for (let i = 0; i < rows.length; i++) {
          try {
            const embeddingStr = `[${embeddings[i].join(",")}]`;
            await db.execute(sql`
              UPDATE document_chunks
              SET embedding = ${embeddingStr}::vector
              WHERE id = ${rows[i].id}
            `);
            reindexProgress.processedChunks++;
          } catch (err: any) {
            logError(`[embeddingPipeline] Reindex update failed for chunk ${rows[i].id}: ${err.message}`);
            reindexProgress.errorCount++;
            if (reindexProgress.errors.length < 20) {
              reindexProgress.errors.push(`Update failed for chunk ${rows[i].id}: ${err.message}`);
            }
          }
        }

        lastId = rows[rows.length - 1].id;

        const elapsed = Date.now() - startTime;
        const rate = reindexProgress.processedChunks / (elapsed / 1000);
        if (rate > 0) {
          const remaining = totalChunks - reindexProgress.processedChunks;
          reindexProgress.estimatedTimeRemaining = Math.round(remaining / rate);
        }

        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
      } catch (batchErr: any) {
        logError(`[embeddingPipeline] Reindex batch failed: ${batchErr.message}`);
        reindexProgress.errorCount += rows.length;
        if (reindexProgress.errors.length < 20) {
          reindexProgress.errors.push(`Batch failed: ${batchErr.message}`);
        }
        lastId = rows[rows.length - 1].id;

        if (batchErr.message?.includes("429") || batchErr.message?.includes("quota") || batchErr.message?.includes("rate")) {
          logInfo("[embeddingPipeline] Reindex rate limited, waiting 30 seconds...");
          await new Promise(resolve => setTimeout(resolve, 30000));
        }
      }
    }

    const finalStatus = reindexStopRequested ? "stopped" : "completed";
    reindexProgress.status = finalStatus as ReindexProgress["status"];
    reindexProgress.completedAt = new Date().toISOString();
    logInfo(
      `[embeddingPipeline] Reindex ${finalStatus}: ${reindexProgress.processedChunks}/${totalChunks} chunks, ${reindexProgress.errorCount} errors`
    );
  } catch (error: any) {
    logError(`[embeddingPipeline] Reindex failed: ${error.message}`);
    reindexProgress.status = "failed";
    reindexProgress.completedAt = new Date().toISOString();
    reindexProgress.errors.push(error.message || "Unknown error");
  }
}
