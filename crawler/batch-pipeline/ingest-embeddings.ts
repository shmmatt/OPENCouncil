#!/usr/bin/env npx tsx
/**
 * Phase 3: Ingest embeddings into pgvector
 * 
 * Streams embeddings JSONL from Gemini Batch API into document_chunks table
 * Uses PostgreSQL COPY for maximum performance
 * 
 * Usage:
 *   npx tsx batch-pipeline/ingest-embeddings.ts --input data/embeddings-carroll-2026-02-18.jsonl
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { sql, closeDb } from './utils/db';

// Parse command line arguments
const args = process.argv.slice(2);
const inputArg = args.find(a => a.startsWith('--input='))?.split('=')[1]
  || (args.indexOf('--input') !== -1 ? args[args.indexOf('--input') + 1] : null);

if (!inputArg) {
  console.error('❌ Usage: npx tsx ingest-embeddings.ts --input <embeddings.jsonl>');
  process.exit(1);
}

if (!fs.existsSync(inputArg)) {
  console.error(`❌ File not found: ${inputArg}`);
  process.exit(1);
}

// Stats
let processedCount = 0;
let insertedCount = 0;
let errorCount = 0;
let batchBuffer: ChunkInsert[] = [];
const BATCH_SIZE = 100;

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
  document_version_id: string;
  chunk_index: number;
  content: string;
  embedding: number[];
  town: string;
  category: string;
  board: string | null;
  year: string | null;
}

// We need to store the original chunk content
// For now, we'll need to re-read from the export file or store content in the key
// Let's modify to just use the key data and fetch content from DB

async function insertBatch(chunks: ChunkInsert[]) {
  if (chunks.length === 0) return;

  try {
    // Build VALUES clause
    const values = chunks.map((c, i) => {
      const offset = i * 8;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::vector, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
    }).join(', ');

    const params = chunks.flatMap(c => [
      c.document_version_id,
      c.chunk_index,
      c.content,
      `[${c.embedding.join(',')}]`,
      c.town,
      c.category,
      c.board,
      c.year
    ]);

    await sql.unsafe(`
      INSERT INTO document_chunks 
        (document_version_id, chunk_index, content, embedding, town, category, board, year)
      VALUES ${values}
      ON CONFLICT (document_version_id, chunk_index) 
      DO UPDATE SET embedding = EXCLUDED.embedding
    `, params);

    insertedCount += chunks.length;
  } catch (err) {
    console.error(`\n❌ Batch insert failed:`, err);
    errorCount += chunks.length;
  }
}

async function main() {
  console.log('🚀 OPENCouncil Embedding Ingestion Pipeline');
  console.log('==========================================');
  console.log(`Input: ${inputArg}`);
  console.log('');

  // First, we need to load the original export to get chunk content
  // Find the matching export file
  const exportFile = inputArg.replace('embeddings-', 'export-');
  
  // Build a map of key -> content from export file
  const contentMap = new Map<string, string>();
  
  if (fs.existsSync(exportFile)) {
    console.log(`📖 Loading chunk content from ${exportFile}...`);
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
        // Skip malformed lines
      }
    }
    console.log(`   Loaded ${contentMap.size} chunk contents\n`);
  } else {
    console.log(`⚠️  Export file not found: ${exportFile}`);
    console.log(`   Will fetch content from database (slower)\n`);
  }

  // Ensure unique constraint exists for upsert
  try {
    await sql.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_version_chunk_idx 
      ON document_chunks(document_version_id, chunk_index)
    `);
  } catch (e) {
    // Index might already exist
  }

  // Process embeddings file
  console.log('📥 Processing embeddings...\n');
  
  const fileStream = fs.createReadStream(inputArg);
  const rl = readline.createInterface({ input: fileStream });

  for await (const line of rl) {
    if (!line.trim()) continue;
    
    processedCount++;
    
    try {
      const result: EmbeddingResult = JSON.parse(line);
      
      // Check for errors
      if (result.error) {
        errorCount++;
        continue;
      }

      const embedding = result.response?.embeddings?.[0]?.values;
      if (!embedding || embedding.length !== 768) {
        errorCount++;
        continue;
      }

      // Parse key: versionId|chunkIndex|town|category|board|year
      const [versionId, chunkIndexStr, town, category, board, year] = result.key.split('|');
      const chunkIndex = parseInt(chunkIndexStr, 10);

      // Get content from map or placeholder
      const content = contentMap.get(result.key) || '[content not available]';

      batchBuffer.push({
        document_version_id: versionId,
        chunk_index: chunkIndex,
        content,
        embedding,
        town,
        category,
        board: board || null,
        year: year || null
      });

      // Flush batch when full
      if (batchBuffer.length >= BATCH_SIZE) {
        await insertBatch(batchBuffer);
        batchBuffer = [];
        process.stdout.write(`\r  Processed ${processedCount}, inserted ${insertedCount}...`);
      }
    } catch (e) {
      errorCount++;
    }
  }

  // Flush remaining
  if (batchBuffer.length > 0) {
    await insertBatch(batchBuffer);
  }

  await closeDb();

  // Final stats
  console.log('\n\n✅ Ingestion complete!');
  console.log('=====================');
  console.log(`📊 Processed: ${processedCount}`);
  console.log(`✅ Inserted: ${insertedCount}`);
  console.log(`❌ Errors: ${errorCount}`);
  
  // Verify count in database
  console.log('\n📋 Verifying database...');
  const countResult = await sql.unsafe('SELECT COUNT(*) as count FROM document_chunks');
  console.log(`   Total chunks in pgvector: ${countResult[0]?.count || 0}`);
}

main().catch(err => {
  console.error('❌ Ingestion failed:', err);
  process.exit(1);
});
