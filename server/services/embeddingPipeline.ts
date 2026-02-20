import { db, sql } from "../storage/db";
import { generateEmbeddingBatch } from "./embeddingService";
import { logInfo, logError } from "../utils/logger";
import * as crypto from "crypto";

const CHUNK_TARGET_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 200;
const EMBEDDING_BATCH_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 1200;

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
}

async function fetchReadyBlobs(limit: number | null, town: string | null): Promise<FileBlobRow[]> {
  let finalQuery = `
    SELECT 
      fb.id,
      fb.preview_text,
      fb.ocr_text,
      fb.original_filename,
      fb.content_hash,
      ld.town,
      ld.board,
      ld.category,
      dv.year,
      dv.document_id
    FROM file_blobs fb
    LEFT JOIN document_versions dv ON dv.file_blob_id = fb.id AND dv.is_current = true
    LEFT JOIN logical_documents ld ON dv.document_id = ld.id
    WHERE fb.embedding_status = 'none'
      AND (fb.ocr_text IS NOT NULL OR fb.preview_text IS NOT NULL)
      AND (COALESCE(char_length(fb.ocr_text), 0) + COALESCE(char_length(fb.preview_text), 0)) > 100
  `;

  if (town) {
    finalQuery += ` AND LOWER(COALESCE(ld.town, 'unknown')) = LOWER('${town.replace(/'/g, "''")}')`;
  }
  finalQuery += ` ORDER BY COALESCE(ld.town, 'zzz'), fb.original_filename`;
  if (limit) {
    finalQuery += ` LIMIT ${limit}`;
  }

  const result = await db.execute(sql.raw(finalQuery));
  return (result.rows || result) as unknown as FileBlobRow[];
}

async function insertChunk(c: ChunkData & { embedding: number[] }): Promise<void> {
  const metadataJson = JSON.stringify({
    town: c.town || undefined,
    board: c.board || undefined,
    year: c.year || undefined,
    documentType: c.category || undefined,
    fileBlobId: c.fileBlobId,
    contentHash: c.contentHash,
  });
  const embeddingStr = `[${c.embedding.join(",")}]`;

  await db.execute(sql`
    INSERT INTO document_chunks (document_id, file_blob_id, chunk_index, content, embedding, metadata)
    VALUES (${null}, ${c.fileBlobId}, ${c.chunkIndex}, ${c.content}, ${embeddingStr}::vector, ${metadataJson}::jsonb)
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

export async function startPipeline(options?: { limit?: number; town?: string }): Promise<void> {
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

    const blobs = await fetchReadyBlobs(options?.limit || null, options?.town || null);
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
    const texts = chunks.map(c => c.content);
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
