/**
 * Tiny Batch Migration: Just 50 Documents
 * 
 * Bare minimum to test that pgvector retrieval actually works.
 * Once we confirm it works, we can optimize memory for larger migrations.
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

const LIMIT = 50; // Just 50 docs to test
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_DOC = 30; // Reduced further

interface Stats {
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
}

async function ensureIndexes() {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
    ON document_chunks 
    USING hnsw (embedding vector_cosine_ops)
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS document_chunks_town_idx ON document_chunks (town)`);
  logInfo("[migration]", "✅ Indexes ready");
}

async function migrate() {
  const stats: Stats = { processed: 0, skipped: 0, failed: 0, totalChunks: 0 };

  try {
    logInfo("[migration]", `🚀 Test migration: ${LIMIT} documents max`);
    await ensureIndexes();

    // Get just 50 Ossipee docs
    const result = await db.execute(sql`
      SELECT dv.id 
      FROM document_versions dv
      JOIN logical_documents ld ON dv.document_id = ld.id
      WHERE ld.town = 'Ossipee' 
      AND dv.is_current = true
      LIMIT ${LIMIT}
    `);

    const docIds = result.rows.map((r: any) => r.id);
    logInfo("[migration]", `Processing ${docIds.length} documents`);

    for (const docId of docIds) {
      try {
        // Check if done
        const existingJob = await getEmbeddingJobByDocumentVersion(docId);
        if (existingJob?.status === "completed") {
          stats.skipped++;
          continue;
        }

        // Get doc version
        const [docVersion] = await db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, docId));
        if (!docVersion) continue;

        // Get metadata
        const logicalDoc = await getLogicalDocumentById(docVersion.documentId);
        const fileBlob = await getFileBlobById(docVersion.fileBlobId);
        
        if (!logicalDoc || !fileBlob) continue;

        const textContent = fileBlob.ocrText || fileBlob.previewText;
        if (!textContent || textContent.trim().length === 0) {
          stats.skipped++;
          continue;
        }

        // Create job
        const job = await createEmbeddingJob({
          documentVersionId: docVersion.id,
          status: "processing",
        });

        // Chunk
        let chunks = chunkText(textContent, CHUNK_SIZE, CHUNK_OVERLAP);
        if (chunks.length > MAX_CHUNKS_PER_DOC) {
          chunks = chunks.slice(0, MAX_CHUNKS_PER_DOC);
        }

        // Embed
        const embeddings = await generateEmbeddingBatch(chunks);

        // Insert
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

        logInfo("[migration]", `  ✅ ${stats.processed}/${docIds.length} (${stats.totalChunks} chunks total)`);
      } catch (error) {
        stats.failed++;
        logError("[migration]", `Failed:`, error);
      }
    }

    logInfo("[migration]", `\n✅ Done! Processed: ${stats.processed}, Skipped: ${stats.skipped}, Failed: ${stats.failed}`);
    logInfo("[migration]", `Total chunks: ${stats.totalChunks}`);
    process.exit(0);
  } catch (error) {
    logError("[migration]", "Fatal error", error);
    process.exit(1);
  }
}

migrate();
