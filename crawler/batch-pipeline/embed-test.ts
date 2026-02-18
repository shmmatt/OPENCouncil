#!/usr/bin/env npx tsx
/**
 * Test: Embed just 50 chunks to verify pipeline works
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { sql, closeDb } from './utils/db';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`;
const TEST_LIMIT = 50;

let processed = 0;
let inserted = 0;

async function getEmbedding(text: string): Promise<number[] | null> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      outputDimensionality: 768
    })
  });

  if (!response.ok) {
    console.error(`API error: ${response.status}`);
    return null;
  }

  const data = await response.json();
  return data.embedding?.values || null;
}

async function main() {
  console.log(`🧪 Test: Embedding ${TEST_LIMIT} chunks`);

  const inputFile = 'data/export-2026-02-18.jsonl';
  const fileStream = fs.createReadStream(inputFile);
  const rl = readline.createInterface({ input: fileStream });

  // Ensure index exists
  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_version_chunk_idx 
    ON document_chunks(document_version_id, chunk_index)
  `).catch(() => {});

  for await (const line of rl) {
    if (processed >= TEST_LIMIT) break;
    if (!line.trim()) continue;

    const data = JSON.parse(line);
    const key = data.key;
    const content = data.request?.content?.parts?.[0]?.text;
    if (!key || !content) continue;

    const embedding = await getEmbedding(content);
    if (!embedding || embedding.length !== 768) {
      console.log(`❌ Failed chunk ${processed}`);
      continue;
    }

    const [versionId, chunkIndexStr, town, category, board, year] = key.split('|');

    await sql.unsafe(`
      INSERT INTO document_chunks (document_version_id, chunk_index, content, embedding, town, category, board, year)
      VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8)
      ON CONFLICT (document_version_id, chunk_index) DO UPDATE SET embedding = EXCLUDED.embedding
    `, [versionId, parseInt(chunkIndexStr), content, `[${embedding.join(',')}]`, town, category, board || null, year || null]);

    inserted++;
    processed++;
    process.stdout.write(`\r  ${processed}/${TEST_LIMIT} embedded`);
    
    // Small delay for rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  rl.close();
  
  // Verify
  const count = await sql.unsafe('SELECT COUNT(*) as c FROM document_chunks');
  console.log(`\n\n✅ Done! Inserted: ${inserted}, Total in DB: ${count[0].c}`);
  
  // Test retrieval
  console.log('\n🔍 Testing retrieval...');
  const testQuery = "zoning regulations";
  const testEmb = await getEmbedding(testQuery);
  if (testEmb) {
    const results = await sql.unsafe(`
      SELECT content, town, 1 - (embedding <=> $1::vector) as similarity
      FROM document_chunks
      ORDER BY embedding <=> $1::vector
      LIMIT 3
    `, [`[${testEmb.join(',')}]`]);
    
    console.log(`Query: "${testQuery}"`);
    for (const r of results) {
      console.log(`  [${r.similarity.toFixed(3)}] ${r.town}: ${r.content.slice(0, 100)}...`);
    }
  }

  await closeDb();
}

main().catch(e => { console.error(e); process.exit(1); });
