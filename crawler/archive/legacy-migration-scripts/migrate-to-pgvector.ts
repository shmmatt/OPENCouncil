/**
 * Migration Script: Embed Existing Documents to pgvector
 * 
 * Processes all existing DocumentVersions and generates embeddings
 * for them. Stores chunks in the document_chunks table.
 * 
 * Usage: npx tsx scripts/migrate-to-pgvector.ts
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

const BATCH_SIZE = 10; // Process 10 documents at a time
const CHUNK_SIZE = 1000; // Characters per chunk
const CHUNK_OVERLAP = 200; // Overlap between chunks

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
    // Create HNSW index for cosine distance (faster than sequential scan)
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
      ON document_chunks 
      USING hnsw (embedding vector_cosine_ops)
    `);
    
    // Create indexes on filter columns
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
      logInfo("[migration]", `⏭️  Skipping ${docVersion.id} (already embedded)`);
      stats.skipped++;
      return;
    }

    // Get logical document metadata
    const logicalDoc = await getLogicalDocumentById(docVersion.documentId);
    if (!logicalDoc) {
      logError("[migration]", `Missing logical document for version ${docVersion.id}`);
      stats.failed++;
      return;
    }

    // Get file blob with text content
    const fileBlob = await getFileBlobById(docVersion.fileBlobId);
    if (!fileBlob) {
      logError("[migration]", `Missing file blob for version ${docVersion.id}`);
      stats.failed++;
      return;
    }

    // Determine which text to use (OCR text if available, otherwise preview)
    const textContent = fileBlob.ocrText || fileBlob.previewText;
    if (!textContent || textContent.trim().length === 0) {
      logInfo("[migration]", `⏭️  Skipping ${logicalDoc.canonicalTitle} (no text content)`);
      stats.skipped++;
      return;
    }

    logInfo(
      "[migration]",
      `📄 Processing: ${logicalDoc.canonicalTitle} (${logicalDoc.town}, ${textContent.length} chars)`
    );

    // Create embedding job
    const job = await createEmbeddingJob({
      documentVersionId: docVersion.id,
      status: "processing",
    });

    // Chunk the text
    const chunks = chunkText(textContent, CHUNK_SIZE, CHUNK_OVERLAP);
    logInfo("[migration]", `  Split into ${chunks.length} chunks`);

    if (chunks.length === 0) {
      stats.skipped++;
      return;
    }

    // Generate embeddings in batches
    const embeddings = await generateEmbeddingBatch(chunks);
    logInfo("[migration]", `  Generated ${embeddings.length} embeddings`);

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
    logInfo("[migration]", `  ✅ Inserted ${chunkRecords.length} chunks`);

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
  } catch (error) {
    logError("[migration]", `Failed to process document version ${docVersion.id}`, error);
    stats.failed++;

    // Update job status to failed
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
      logError("[migration]", "Failed to update job status", updateError);
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
    logInfo("[migration]", "🚀 Starting pgvector migration...");

    // Ensure extension and indexes
    await ensurePgvectorExtension();
    await createIndexes();

    // Get all document versions that are current
    const documentVersions = await db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.isCurrent, true));

    stats.total = documentVersions.length;
    logInfo("[migration]", `Found ${stats.total} document versions to process`);

    // Process in batches
    for (let i = 0; i < documentVersions.length; i += BATCH_SIZE) {
      const batch = documentVersions.slice(i, i + BATCH_SIZE);
      
      logInfo(
        "[migration]",
        `\n📦 Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(documentVersions.length / BATCH_SIZE)} (documents ${i + 1}-${Math.min(i + BATCH_SIZE, documentVersions.length)})`
      );

      // Process batch sequentially (to avoid rate limits)
      for (const docVersion of batch) {
        await processDocumentVersion(docVersion, stats);
      }

      // Progress report
      logInfo(
        "[migration]",
        `Progress: ${stats.processed + stats.skipped + stats.failed}/${stats.total} ` +
        `(${stats.processed} processed, ${stats.skipped} skipped, ${stats.failed} failed, ${stats.totalChunks} chunks)`
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
