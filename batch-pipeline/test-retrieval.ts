#!/usr/bin/env npx tsx
/**
 * Test pgvector retrieval
 */

import { sql, closeDb } from './utils/db';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const QUERY = process.argv[2] || "What are the setback requirements in Ossipee?";

async function getEmbedding(text: string): Promise<number[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        outputDimensionality: 768
      })
    }
  );
  const data = await resp.json();
  return data.embedding.values;
}

async function main() {
  console.log(`🔍 Query: "${QUERY}"\n`);
  
  const embedding = await getEmbedding(QUERY);
  
  const results = await sql.unsafe(`
    SELECT town, category, board, year, LEFT(content, 300) as excerpt, 
           1 - (embedding <=> $1::vector) as similarity
    FROM document_chunks
    ORDER BY embedding <=> $1::vector
    LIMIT 5
  `, [`[${embedding.join(',')}]`]);
  
  for (const r of results) {
    console.log(`[${Number(r.similarity).toFixed(3)}] ${r.town} / ${r.category}${r.board ? ' / ' + r.board : ''}`);
    console.log(`   ${r.excerpt}...\n`);
  }
  
  await closeDb();
}

main();
