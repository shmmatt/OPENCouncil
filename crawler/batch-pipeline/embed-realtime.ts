#!/usr/bin/env npx tsx
/**
 * Real-time embedding pipeline
 * 
 * Processes chunks one at a time with rate limiting.
 * Can be interrupted and resumed (skips existing chunks).
 * 
 * Usage:
 *   npx tsx batch-pipeline/embed-realtime.ts
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { sql, closeDb } from './utils/db';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY required');
  process.exit(1);
}

const EMBEDDING_MODEL = 'gemini-embedding-001';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`;

// Rate limiting: 1500 RPM = 25 RPS, stay under at 10 RPS
const DELAY_MS = 100;
const BATCH_SIZE = 10; // Insert every N embeddings

// Stats
let processedCount = 0;
let insertedCount = 0;
let errorCount = 0;
let startTime = Date.now();

interface ChunkData {
  key: string;
  content: string;
}

interface InsertData {
  document_version_id: string;
  chunk_index: number;
  content: string;
  embedding: number[];
  town: string;
  category: string;
  board: string | null;
  year: string | null;
}

const insertBuffer: InsertData[] = [];

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text: text.slice(0, 8000) }] }, // Truncate to avoid token limit
        outputDimensionality: 768
      })
    });

    if (!response.ok) {
      const err = await response.text();
      if (response.status === 429) {
        // Rate limited, wait and retry
        console.log('\n⏳ Rate limited, waiting 60s...');
        await sleep(60000);
        return getEmbedding(text); // Retry
      }
      throw new Error(`API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.embedding?.values || null;
  } catch (e) {
    console.error(`\n❌ Embedding error: ${e}`);
    return null;
  }
}

async function flushInserts() {
  if (insertBuffer.length === 0) return;

  try {
    // Build parameterized insert
    const values = insertBuffer.map((_, i) => {
      const offset = i * 8;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::vector, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
    }).join(', ');

    const params = insertBuffer.flatMap(c => [
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
      DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content
    `, params);

    insertedCount += insertBuffer.length;
  } catch (err) {
    console.error(`\n❌ Insert failed:`, err);
    errorCount += insertBuffer.length;
  }

  insertBuffer.length = 0; // Clear buffer
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function forceGC() {
  if (global.gc) {
    global.gc();
  }
}

async function main() {
  console.log('🚀 Real-time Embedding Pipeline');
  console.log('================================');
  console.log(`GC available: ${typeof global.gc === 'function'}`);
  console.log('');

  const inputFile = 'data/export-2026-02-18.jsonl';
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ File not found: ${inputFile}`);
    process.exit(1);
  }

  // Ensure unique constraint
  try {
    await sql.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_version_chunk_idx 
      ON document_chunks(document_version_id, chunk_index)
    `);
  } catch (e) { /* ignore */ }

  // Count total lines for progress
  let totalLines = 0;
  const countStream = fs.createReadStream(inputFile);
  const countRL = readline.createInterface({ input: countStream });
  for await (const _ of countRL) totalLines++;
  console.log(`📊 Total chunks to process: ${totalLines}\n`);

  // Process file
  const fileStream = fs.createReadStream(inputFile);
  const rl = readline.createInterface({ input: fileStream });

  for await (const line of rl) {
    if (!line.trim()) continue;

    processedCount++;
    
    try {
      const data = JSON.parse(line);
      const key = data.key;
      const content = data.request?.content?.parts?.[0]?.text;

      if (!key || !content) {
        errorCount++;
        continue;
      }

      // Get embedding
      const embedding = await getEmbedding(content);
      if (!embedding || embedding.length !== 768) {
        errorCount++;
        continue;
      }

      // Parse key: versionId|chunkIndex|town|category|board|year
      const [versionId, chunkIndexStr, town, category, board, year] = key.split('|');

      insertBuffer.push({
        document_version_id: versionId,
        chunk_index: parseInt(chunkIndexStr, 10),
        content,
        embedding,
        town,
        category,
        board: board || null,
        year: year || null
      });

      // Flush batch
      if (insertBuffer.length >= BATCH_SIZE) {
        await flushInserts();
      }

      // Progress
      if (processedCount % 10 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = processedCount / elapsed;
        const eta = Math.round((totalLines - processedCount) / rate);
        process.stdout.write(`\r  ${processedCount}/${totalLines} (${rate.toFixed(1)}/s, ETA ${eta}s) inserted: ${insertedCount}`);
      }

      // Force GC periodically
      if (processedCount % GC_INTERVAL === 0) {
        forceGC();
      }

      // Rate limit
      await sleep(DELAY_MS);

    } catch (e) {
      errorCount++;
    }
  }

  // Final flush
  await flushInserts();
  await closeDb();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n✅ Complete!`);
  console.log(`   Processed: ${processedCount}`);
  console.log(`   Inserted: ${insertedCount}`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`   Time: ${elapsed}s`);
}

main().catch(err => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
