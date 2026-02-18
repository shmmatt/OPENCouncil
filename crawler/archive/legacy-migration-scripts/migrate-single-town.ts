/**
 * Single-Town Migration with Explicit GC
 * 
 * Usage: tsx --expose-gc scripts/migrate-single-town.ts --town Ossipee
 * 
 * Processes ONE document at a time with aggressive memory cleanup.
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
import type { InsertDocumentChunk } from "@shared/schema";

const args = process.argv.slice(2);
const townArg = args.find(a => a.startsWith('--town='));
const TOWN = townArg ? townArg.split('=')[1] : 'Ossipee';
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_DOC = 30;
const GC_INTERVAL = 50; // Force GC every 50 docs

let processed = 0;
let skipped = 0;
let failed = 0;
let totalChunks = 0;

async function ensureIndexes() {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
    ON document_chunks 
    USING hnsw (embedding vector_cosine_ops)
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS document_chunks_town_idx ON document_chunks (town)`);
  console.log("✅ Indexes ready");
}

async function processOneDocument(docId: string): Promise<void> {
  try {
    // Check if already done
    const existingJob = await getEmbeddingJobByDocumentVersion(docId);
    if (existingJob?.status === "completed") {
      skipped++;
      return;
    }

    // Get document version
    const [docVersion] = await db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.id, docId));

    if (!docVersion) {
      failed++;
      return;
    }

    // Get metadata
    const logicalDoc = await getLogicalDocumentById(docVersion.documentId);
    const fileBlob = await getFileBlobById(docVersion.fileBlobId);
    
    if (!logicalDoc || !fileBlob) {
      failed++;
      return;
    }

    const textContent = fileBlob.ocrText || fileBlob.previewText;
    if (!textContent || textContent.trim().length === 0) {
      skipped++;
      return;
    }

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
      skipped++;
      return;
    }

    // Generate embeddings - DO NOT STORE IN ARRAY
    const embeddings = await generateEmbeddingBatch(chunks);

    // Immediately convert and insert - DO NOT ACCUMULATE
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

    processed++;
    totalChunks += chunkRecords.length;

    // Explicitly null out large objects
    chunks = [];
    embeddings.length = 0;
    chunkRecords.length = 0;
  } catch (error) {
    console.error(`❌ Failed doc ${docId}:`, error instanceof Error ? error.message : String(error));
    failed++;
  }
}

async function migrate() {
  try {
    console.log(`🚀 Migrating town: ${TOWN}`);
    console.log(`GC available: ${typeof global.gc === 'function'}`);
    
    await ensureIndexes();

    // Get document IDs for this town
    const result = await db.execute(sql`
      SELECT dv.id 
      FROM document_versions dv
      JOIN logical_documents ld ON dv.document_id = ld.id
      WHERE ld.town = ${TOWN}
      AND dv.is_current = true
    `);

    const docIds = result.rows.map((r: any) => r.id);
    const total = docIds.length;
    
    console.log(`Found ${total} documents in ${TOWN}\n`);

    // Process ONE AT A TIME
    for (let i = 0; i < total; i++) {
      await processOneDocument(docIds[i]);

      // Force GC every N documents
      if ((i + 1) % GC_INTERVAL === 0 && global.gc) {
        global.gc();
        console.log(`  🗑️  Forced GC at doc ${i + 1}/${total}`);
      }

      // Progress report every 10
      if ((i + 1) % 10 === 0) {
        const pct = ((i + 1) / total * 100).toFixed(1);
        console.log(`Progress: ${i + 1}/${total} (${pct}%) | ✅${processed} ⏭️${skipped} ❌${failed} | ${totalChunks} chunks`);
      }
    }

    console.log(`\n✅ Migration complete!`);
    console.log(`Town: ${TOWN}`);
    console.log(`Processed: ${processed}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total chunks: ${totalChunks}`);
    console.log(`Avg chunks/doc: ${(totalChunks / Math.max(processed, 1)).toFixed(1)}`);

    process.exit(0);
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

migrate();
