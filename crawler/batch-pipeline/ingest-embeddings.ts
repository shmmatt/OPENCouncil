#!/usr/bin/env npx tsx
/**
 * Phase 3: Ingest embeddings into pgvector
 * 
 * Reads Gemini Batch API embedding results and inserts into document_chunks.
 * Writes file_blob_id into chunks for lineage tracking.
 * Updates file_blobs.embedding_status to 'indexed' with chunk_count.
 * Logs completion to embedding_jobs table.
 * 
 * Key format (from export): fileBlobId|chunkIndex|town|category|board|year|contentHash
 * 
 * Usage:
 *   npx tsx batch-pipeline/ingest-embeddings.ts --input data/embeddings-2026-02-19.jsonl [--batch-id batch-xxx]
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { sql, closeDb } from './utils/db';

const args = process.argv.slice(2);
const inputArg = args.find(a => a.startsWith('--input='))?.split('=')[1]
  || (args.indexOf('--input') !== -1 ? args[args.indexOf('--input') + 1] : null);
const batchIdArg = args.find(a => a.startsWith('--batch-id='))?.split('=')[1]
  || (args.indexOf('--batch-id') !== -1 ? args[args.indexOf('--batch-id') + 1] : null);

if (!inputArg) {
  console.error('Usage: npx tsx ingest-embeddings.ts --input <embeddings.jsonl> [--batch-id <id>]');
  process.exit(1);
}

if (!fs.existsSync(inputArg)) {
  console.error(`File not found: ${inputArg}`);
  process.exit(1);
}

let processedCount = 0;
let insertedCount = 0;
let errorCount = 0;
let batchBuffer: ChunkInsert[] = [];
const BATCH_SIZE = 100;

const fileBlobChunkCounts = new Map<string, number>();

interface EmbeddingResult {
  key: string;
  response?: {
    embeddings?: Array<{
      values: number[];
    }>;
  };
  error?: string;
}

interface ChunkInsert {
  file_blob_id: string;
  document_id: string | null;
  chunk_index: number;
  content: string;
  embedding: number[];
  town: string;
  category: string;
  board: string | null;
  year: string | null;
  content_hash: string;
}

async function insertBatch(chunks: ChunkInsert[]) {
  if (chunks.length === 0) return;

  try {
    const values = chunks.map((_, i) => {
      const o = i * 9;
      return `($${o+1}, $${o+2}, $${o+3}, $${o+4}, $${o+5}::vector, $${o+6}::jsonb, $${o+7}, $${o+8}, $${o+9})`;
    }).join(', ');

    const params = chunks.flatMap(c => [
      c.document_id,
      c.file_blob_id,
      c.chunk_index,
      c.content,
      `[${c.embedding.join(',')}]`,
      JSON.stringify({
        town: c.town || undefined,
        board: c.board || undefined,
        year: c.year || undefined,
        documentType: c.category || undefined,
        filename: undefined,
        fileBlobId: c.file_blob_id,
        contentHash: c.content_hash,
      }),
      c.town,
      c.category,
      c.content_hash
    ]);

    await sql.unsafe(`
      INSERT INTO document_chunks 
        (document_id, file_blob_id, chunk_index, content, embedding, metadata, 
         -- temp columns for dedup check only, not stored
         _town, _category, _content_hash)
      SELECT 
        v.document_id, v.file_blob_id, v.chunk_index, v.content, v.embedding, v.metadata,
        v._town, v._category, v._content_hash
      FROM (VALUES ${values}) AS v(document_id, file_blob_id, chunk_index, content, embedding, metadata, _town, _category, _content_hash)
    `, params);

    insertedCount += chunks.length;
  } catch (err: any) {
    if (err.message?.includes('_town') || err.message?.includes('_category') || err.message?.includes('_content_hash')) {
      await insertBatchSimple(chunks);
    } else {
      console.error(`\nBatch insert failed:`, err.message);
      errorCount += chunks.length;
    }
  }
}

async function insertBatchSimple(chunks: ChunkInsert[]) {
  if (chunks.length === 0) return;

  try {
    const values = chunks.map((_, i) => {
      const o = i * 6;
      return `($${o+1}, $${o+2}, $${o+3}, $${o+4}, $${o+5}::vector, $${o+6}::jsonb)`;
    }).join(', ');

    const params = chunks.flatMap(c => [
      c.document_id,
      c.file_blob_id,
      c.chunk_index,
      c.content,
      `[${c.embedding.join(',')}]`,
      JSON.stringify({
        town: c.town || undefined,
        board: c.board || undefined,
        year: c.year || undefined,
        documentType: c.category || undefined,
        fileBlobId: c.file_blob_id,
        contentHash: c.content_hash,
      }),
    ]);

    await sql.unsafe(`
      INSERT INTO document_chunks 
        (document_id, file_blob_id, chunk_index, content, embedding, metadata)
      VALUES ${values}
    `, params);

    insertedCount += chunks.length;
  } catch (err: any) {
    console.error(`\nSimple batch insert failed:`, err.message);
    errorCount += chunks.length;
  }
}

async function main() {
  console.log('OPENCouncil Embedding Ingestion Pipeline');
  console.log('=========================================');
  console.log(`Input: ${inputArg}`);
  if (batchIdArg) console.log(`Batch ID: ${batchIdArg}`);
  console.log('');

  const exportFile = inputArg.replace('embeddings-', 'export-');
  const contentMap = new Map<string, string>();

  if (fs.existsSync(exportFile)) {
    console.log(`Loading chunk content from ${exportFile}...`);
    const exportStream = fs.createReadStream(exportFile);
    const exportRL = readline.createInterface({ input: exportStream });

    for await (const line of exportRL) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const content = data.request?.content?.parts?.[0]?.text;
        if (data.key && content) {
          contentMap.set(data.key, content);
        }
      } catch (e) {
        // skip
      }
    }
    console.log(`   Loaded ${contentMap.size} chunk contents\n`);
  } else {
    console.log(`Export file not found: ${exportFile}`);
    console.log(`   Will use placeholder content (embeddings still valid)\n`);
  }

  // Build fileBlobId -> logical_document_id mapping
  console.log('Loading file_blob -> logical_document mappings...');
  const mappingResult = await sql.unsafe(`
    SELECT dv.file_blob_id, dv.document_id 
    FROM document_versions dv 
    WHERE dv.is_current = true AND dv.file_blob_id IS NOT NULL
  `);
  const blobToDocMap = new Map<string, string>();
  for (const row of mappingResult) {
    blobToDocMap.set(row.file_blob_id, row.document_id);
  }
  console.log(`   Loaded ${blobToDocMap.size} mappings\n`);

  console.log('Processing embeddings...\n');

  const fileStream = fs.createReadStream(inputArg);
  const rl = readline.createInterface({ input: fileStream });

  for await (const line of rl) {
    if (!line.trim()) continue;

    processedCount++;

    try {
      const result: EmbeddingResult = JSON.parse(line);

      if (result.error) {
        errorCount++;
        continue;
      }

      const embedding = result.response?.embeddings?.[0]?.values;
      if (!embedding || embedding.length !== 768) {
        errorCount++;
        continue;
      }

      // Parse key: fileBlobId|chunkIndex|town|category|board|year|contentHash
      const parts = result.key.split('|');
      const fileBlobId = parts[0];
      const chunkIndex = parseInt(parts[1], 10);
      const town = parts[2] || 'unknown';
      const category = parts[3] || 'general';
      const board = parts[4] || null;
      const year = parts[5] || null;
      const contentHash = parts[6] || '';

      const content = contentMap.get(result.key) || '[content not available]';

      const documentId = blobToDocMap.get(fileBlobId) || null;

      fileBlobChunkCounts.set(fileBlobId, (fileBlobChunkCounts.get(fileBlobId) || 0) + 1);

      batchBuffer.push({
        file_blob_id: fileBlobId,
        document_id: documentId,
        chunk_index: chunkIndex,
        content,
        embedding,
        town,
        category,
        board,
        year,
        content_hash: contentHash,
      });

      if (batchBuffer.length >= BATCH_SIZE) {
        await insertBatchSimple(batchBuffer);
        batchBuffer = [];
        process.stdout.write(`\r  Processed ${processedCount}, inserted ${insertedCount}...`);
      }
    } catch (e) {
      errorCount++;
    }
  }

  if (batchBuffer.length > 0) {
    await insertBatchSimple(batchBuffer);
  }

  // Update file_blobs embedding_status to 'indexed' with chunk_count
  console.log(`\n\nUpdating ${fileBlobChunkCounts.size} file_blobs to embedding_status='indexed'...`);

  const entries = Array.from(fileBlobChunkCounts.entries());
  const UPDATE_BATCH = 200;
  for (let i = 0; i < entries.length; i += UPDATE_BATCH) {
    const batch = entries.slice(i, i + UPDATE_BATCH);
    for (const [blobId, count] of batch) {
      await sql.unsafe(
        `UPDATE file_blobs 
         SET embedding_status = 'indexed', 
             chunk_count = $1, 
             embedded_at = NOW() 
         WHERE id = $2`,
        [count, blobId]
      );
    }
  }

  // Update embedding_jobs record
  if (batchIdArg) {
    await sql.unsafe(`
      UPDATE embedding_jobs 
      SET status = 'completed', 
          chunks_count = $1, 
          file_blobs_processed = $2, 
          completed_at = NOW() 
      WHERE batch_id = $3
    `, [insertedCount, fileBlobChunkCounts.size, batchIdArg]);
  } else {
    await sql.unsafe(`
      INSERT INTO embedding_jobs (batch_id, status, chunks_count, file_blobs_processed, started_at, completed_at)
      VALUES ($1, 'completed', $2, $3, NOW(), NOW())
    `, [`ingest-${Date.now().toString(36)}`, insertedCount, fileBlobChunkCounts.size]);
  }

  // Verify
  const countResult = await sql.unsafe('SELECT COUNT(*) as count FROM document_chunks');
  const blobStatusResult = await sql.unsafe(`
    SELECT embedding_status, count(*) as cnt 
    FROM file_blobs 
    GROUP BY embedding_status 
    ORDER BY cnt DESC
  `);

  await closeDb();

  console.log('\n\nIngestion complete!');
  console.log('=====================');
  console.log(`Processed: ${processedCount}`);
  console.log(`Inserted: ${insertedCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`File blobs indexed: ${fileBlobChunkCounts.size}`);
  console.log(`\nTotal chunks in pgvector: ${countResult[0]?.count || 0}`);
  console.log('\nFile blob embedding status breakdown:');
  for (const row of blobStatusResult) {
    console.log(`   ${row.embedding_status}: ${row.cnt}`);
  }
}

main().catch(err => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
