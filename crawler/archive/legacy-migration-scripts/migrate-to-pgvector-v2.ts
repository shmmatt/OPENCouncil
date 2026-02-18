/**
 * Memory-Efficient Migration Script: Embed Existing Documents to pgvector
 * 
 * V2: Optimized for large document counts with aggressive memory management
 */

import { db, schema, eq, sql } from "../server/storage/db";
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
import type { DocumentVersion, InsertDocumentChunk } from "@shared/schema";
import { logInfo, logError } from "../server/utils/logger";

const BATCH_SIZE = 5; // Reduced to 5 documents at a time for memory efficiency
const CHUNK_SIZE = 800; // Reduced chunk size
const CHUNK_OVERLAP = 150; // Reduced overlap
const MAX_CHUNKS_PER_DOC = 50; // Limit chunks per document

interface MigrationStats {
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
}

async function ensurePgvectorExtension() {
  logInfo("[migration]", "Ensuring pgvector extension is enabled...");
  
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    logInfo("[migration]", "✅ pgvector extension enabled");
  } catch (error) {
    logError("[migration]", "Failed to enable pgvector extension", error);
    throw error;
  }
}

async function createIndexes() {
  logInfo("[migration]", "Creating HNSW index for fast similarity search...");
  
  try {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
      ON document_chunks 
      USING hnsw (embedding vector_cosine_ops)
    `);
    
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_chunks_town_idx 
      ON document_chunks (town)
    `);
    
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_chunks_category_idx 
      ON document_chunks (category)
    `);
    
    logInfo("[migration]", "✅ Indexes created");
  } catch (error) {
    logError("[migration]", "Failed to create indexes", error);
    throw error;
  }
}

async function processDocumentVersion(
  docVersion: DocumentVersion,
  stats: MigrationStats
): Promise<void> {
  try {
    // Check if already processed
    const existingJob = await getEmbeddingJobByDocumentVersion(docVersion.id);
    if (existingJob && existingJob.status === "completed") {
      stats.skipped++;
      return;
    }

    // Get logical document metadata
    const logicalDoc = await getLogicalDocumentById(docVersion.documentId);
    if (!logicalDoc) {
      stats.failed++;
      return;
    }

    // Get file blob with text content
    const fileBlob = await getFileBlobById(docVersion.fileBlobId);
    if (!fileBlob) {
      stats.failed++;
      return;
    }

    // Determine which text to use
    const textContent = fileBlob.ocrText || fileBlob.previewText;
    if (!textContent || textContent.trim().length === 0) {
      stats.skipped++;
      return;
    }

    // Log progress
    const shortTitle = logicalDoc.canonicalTitle.slice(0, 60);
    logInfo("[migration]", `📄 ${shortTitle} (${logicalDoc.town}, ${textContent.length} chars)`);

    // Create embedding job
    const job = await createEmbeddingJob({
      documentVersionId: docVersion.id,
      status: "processing",
    });

    // Chunk the text
    let chunks = chunkText(textContent, CHUNK_SIZE, CHUNK_OVERLAP);
    
    // Limit chunks to prevent memory issues
    if (chunks.length > MAX_CHUNKS_PER_DOC) {
      chunks = chunks.slice(0, MAX_CHUNKS_PER_DOC);
      logInfo("[migration]", `  ⚠️  Limited to ${MAX_CHUNKS_PER_DOC} chunks (was ${chunks.length})`);
    }

    if (chunks.length === 0) {
      stats.skipped++;
      return;
    }

    // Generate embeddings
    const embeddings = await generateEmbeddingBatch(chunks);

    // Prepare chunk records
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

    // Update job status
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
    
    // Force garbage collection hint
    if (global.gc) {
      global.gc();
    }
  } catch (error) {
    logError("[migration]", `Failed to process document version ${docVersion.id}`, error);
    stats.failed++;

    try {
      const job = await getEmbeddingJobByDocumentVersion(docVersion.id);
      if (job) {
        await db
          .update(schema.embeddingJobs)
          .set({
            status: "failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          })
          .where(eq(schema.embeddingJobs.id, job.id));
      }
    } catch (updateError) {
      // Ignore
    }
  }
}

async function migrateAllDocuments() {
  const stats: MigrationStats = {
    total: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    totalChunks: 0,
  };

  try {
    logInfo("[migration]", "🚀 Starting pgvector migration (memory-optimized)...");

    await ensurePgvectorExtension();
    await createIndexes();

    // Get total count
    const countResult = await db.execute(sql`
      SELECT COUNT(*) as count 
      FROM document_versions 
      WHERE is_current = true
    `);
    stats.total = Number(countResult.rows[0].count);
    
    logInfo("[migration]", `Found ${stats.total} document versions to process`);
    logInfo("[migration]", `Processing in batches of ${BATCH_SIZE}`);

    // Process in batches using OFFSET/LIMIT to avoid loading all at once
    let offset = 0;
    const limit = BATCH_SIZE;
    let batchNum = 1;

    while (offset < stats.total) {
      logInfo(
        "[migration]",
        `\n📦 Batch ${batchNum} (offset ${offset}, ${stats.processed + stats.skipped + stats.failed}/${stats.total} complete)`
      );

      // Fetch only this batch
      const batch = await db
        .select()
        .from(schema.documentVersions)
        .where(eq(schema.documentVersions.isCurrent, true))
        .limit(limit)
        .offset(offset);

      if (batch.length === 0) break;

      // Process batch sequentially
      for (const docVersion of batch) {
        await processDocumentVersion(docVersion, stats);
      }

      offset += limit;
      batchNum++;

      // Progress report
      const percentDone = ((stats.processed + stats.skipped + stats.failed) / stats.total * 100).toFixed(1);
      logInfo(
        "[migration]",
        `Progress: ${stats.processed + stats.skipped + stats.failed}/${stats.total} (${percentDone}%) ` +
        `| ✅ ${stats.processed} | ⏭️  ${stats.skipped} | ❌ ${stats.failed} | 📊 ${stats.totalChunks} chunks`
      );
    }

    // Final report
    logInfo("[migration]", "\n✅ Migration complete!");
    logInfo("[migration]", `Total documents: ${stats.total}`);
    logInfo("[migration]", `Successfully processed: ${stats.processed}`);
    logInfo("[migration]", `Skipped: ${stats.skipped}`);
    logInfo("[migration]", `Failed: ${stats.failed}`);
    logInfo("[migration]", `Total chunks created: ${stats.totalChunks}`);
    logInfo(
      "[migration]",
      `Average chunks per document: ${(stats.totalChunks / Math.max(stats.processed, 1)).toFixed(1)}`
    );
  } catch (error) {
    logError("[migration]", "Migration failed", error);
    throw error;
  }
}

// Run migration
migrateAllDocuments()
  .then(() => {
    logInfo("[migration]", "🎉 Done!");
    process.exit(0);
  })
  .catch((error) => {
    logError("[migration]", "Fatal error", error);
    process.exit(1);
  });
