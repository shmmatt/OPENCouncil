/**
 * Streaming Migration: Ossipee Documents Only
 * 
 * Processes one document at a time using PostgreSQL cursor to avoid memory issues.
 * This is a pilot to verify pgvector works before migrating all towns.
 */

import { db, schema, eq, sql, and } from "../server/storage/db";
import { getFileBlobById } from "../server/storage/fileBlobs";
import { getLogicalDocumentById } from "../server/storage/documents";
import {
  chunkText,
  generateEmbeddingBatch,
} from "../server/services/embeddingService";
import {
  createEmbeddingJob,
  insertDocumentChunkBatch,
  getEmbeddingJobByDocumentVersion,
} from "../server/services/embeddingStorage";
import type { InsertDocumentChunk } from "@shared/schema";
import { logInfo, logError } from "../server/utils/logger";

const TARGET_TOWN = "Ossipee";
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_DOC = 50;

interface Stats {
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
}

async function ensureIndexes() {
  logInfo("[migration]", "Ensuring indexes exist...");
  
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
      ON document_chunks 
      USING hnsw (embedding vector_cosine_ops)
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS document_chunks_town_idx ON document_chunks (town)`);
    logInfo("[migration]", "✅ Indexes ready");
  } catch (error) {
    logError("[migration]", "Failed to create indexes", error);
    throw error;
  }
}

async function processDocument(docVersionId: string, stats: Stats): Promise<void> {
  try {
    // Check if already processed
    const existingJob = await getEmbeddingJobByDocumentVersion(docVersionId);
    if (existingJob && existingJob.status === "completed") {
      stats.skipped++;
      return;
    }

    // Get document version
    const [docVersion] = await db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.id, docVersionId));

    if (!docVersion) {
      stats.failed++;
      return;
    }

    // Get logical document
    const logicalDoc = await getLogicalDocumentById(docVersion.documentId);
    if (!logicalDoc) {
      stats.failed++;
      return;
    }

    // Get file blob
    const fileBlob = await getFileBlobById(docVersion.fileBlobId);
    if (!fileBlob) {
      stats.failed++;
      return;
    }

    const textContent = fileBlob.ocrText || fileBlob.previewText;
    if (!textContent || textContent.trim().length === 0) {
      stats.skipped++;
      return;
    }

    const shortTitle = logicalDoc.canonicalTitle.slice(0, 60);
    logInfo("[migration]", `  📄 ${shortTitle} (${textContent.length} chars)`);

    // Create job
    const job = await createEmbeddingJob({
      documentVersionId: docVersion.id,
      status: "processing",
    });

    // Chunk text
    let chunks = chunkText(textContent, CHUNK_SIZE, CHUNK_OVERLAP);
    if (chunks.length > MAX_CHUNKS_PER_DOC) {
      chunks = chunks.slice(0, MAX_CHUNKS_PER_DOC);
    }

    if (chunks.length === 0) {
      stats.skipped++;
      return;
    }

    // Generate embeddings
    const embeddings = await generateEmbeddingBatch(chunks);

    // Prepare chunks
    const chunkRecords: InsertDocumentChunk[] = chunks.map((content, idx) => ({
      documentVersionId: docVersion.id,
      chunkIndex: idx,
      content,
      embedding: sql.raw(`'[${embeddings[idx].join(",")}]'::vector`),
      town: logicalDoc.town,
      category: logicalDoc.category,
      board: logicalDoc.board || null,
      year: docVersion.year || null,
    }));

    // Insert chunks
    await insertDocumentChunkBatch(chunkRecords);

    // Update job
    await db
      .update(schema.embeddingJobs)
      .set({
        status: "completed",
        chunkCount: chunkRecords.length,
        completedAt: new Date(),
      })
      .where(eq(schema.embeddingJobs.id, job.id));

    stats.processed++;
    stats.totalChunks += chunkRecords.length;
  } catch (error) {
    logError("[migration]", `Failed to process ${docVersionId}`, error);
    stats.failed++;
  }
}

async function migrate() {
  const stats: Stats = { total: 0, processed: 0, skipped: 0, failed: 0, totalChunks: 0 };

  try {
    logInfo("[migration]", `🚀 Starting Ossipee-only migration...`);
    await ensureIndexes();

    // Get Ossipee document IDs using streaming cursor
    const result = await db.execute(sql`
      SELECT dv.id 
      FROM document_versions dv
      JOIN logical_documents ld ON dv.document_id = ld.id
      WHERE ld.town = ${TARGET_TOWN} 
      AND dv.is_current = true
    `);

    const docIds = result.rows.map((r: any) => r.id);
    stats.total = docIds.length;

    logInfo("[migration]", `Found ${stats.total} Ossipee documents to process`);

    // Process one at a time
    for (let i = 0; i < docIds.length; i++) {
      const docId = docIds[i];
      await processDocument(docId, stats);

      if ((i + 1) % 10 === 0) {
        const pct = ((i + 1) / stats.total * 100).toFixed(1);
        logInfo(
          "[migration]",
          `Progress: ${i + 1}/${stats.total} (${pct}%) | ✅ ${stats.processed} | ⏭️  ${stats.skipped} | ❌ ${stats.failed}`
        );
      }
    }

    logInfo("[migration]", "\n✅ Ossipee migration complete!");
    logInfo("[migration]", `Total: ${stats.total}`);
    logInfo("[migration]", `Processed: ${stats.processed}`);
    logInfo("[migration]", `Skipped: ${stats.skipped}`);
    logInfo("[migration]", `Failed: ${stats.failed}`);
    logInfo("[migration]", `Total chunks: ${stats.totalChunks}`);
    logInfo("[migration]", `Avg chunks/doc: ${(stats.totalChunks / Math.max(stats.processed, 1)).toFixed(1)}`);

    process.exit(0);
  } catch (error) {
    logError("[migration]", "Migration failed", error);
    process.exit(1);
  }
}

migrate();
