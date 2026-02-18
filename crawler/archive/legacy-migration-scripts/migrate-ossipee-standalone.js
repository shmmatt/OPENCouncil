/**
 * Standalone Ossipee Migration (Pure JS ES Module)
 * 
 * Run with: node --expose-gc --max-old-space-size=4096 migrate-ossipee-standalone.js
 * 
 * No tsx, no TypeScript - just pure Node.js with explicit memory management
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TOWN = 'Ossipee';
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_DOC = 30;
const GC_INTERVAL = 25; // Force GC every 25 docs

let processed = 0;
let skipped = 0;
let failed = 0;
let totalChunks = 0;

// Simple text chunking
function chunkText(text, chunkSize, overlap) {
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    
    start = end - overlap;
    if (start >= text.length) break;
  }
  
  return chunks;
}

// Call Gemini embedding API
async function generateEmbeddings(texts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${GEMINI_API_KEY}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map(text => ({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: 768,
      })),
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }
  
  const result = await response.json();
  return result.embeddings.map(e => e.values);
}

async function processDocument(sql, docId) {
  try {
    // Check if already done
    const existingJobs = await sql`
      SELECT status FROM embedding_jobs WHERE document_version_id = ${docId}
    `;
    
    if (existingJobs.length > 0 && existingJobs[0].status === 'completed') {
      skipped++;
      return;
    }

    // Get document version
    const docVersions = await sql`
      SELECT * FROM document_versions WHERE id = ${docId}
    `;
    
    if (docVersions.length === 0) {
      failed++;
      return;
    }
    
    const docVersion = docVersions[0];

    // Get logical document
    const logicalDocs = await sql`
      SELECT * FROM logical_documents WHERE id = ${docVersion.document_id}
    `;
    
    if (logicalDocs.length === 0) {
      failed++;
      return;
    }
    
    const logicalDoc = logicalDocs[0];

    // Get file blob
    const fileBlobs = await sql`
      SELECT * FROM file_blobs WHERE id = ${docVersion.file_blob_id}
    `;
    
    if (fileBlobs.length === 0) {
      failed++;
      return;
    }
    
    const fileBlob = fileBlobs[0];
    const textContent = fileBlob.ocr_text || fileBlob.preview_text;
    
    if (!textContent || textContent.trim().length === 0) {
      skipped++;
      return;
    }

    // Create embedding job
    await sql`
      INSERT INTO embedding_jobs (document_version_id, status)
      VALUES (${docVersion.id}, 'processing')
      ON CONFLICT (document_version_id) DO UPDATE SET status = 'processing'
    `;

    // Chunk text
    let chunks = chunkText(textContent, CHUNK_SIZE, CHUNK_OVERLAP);
    if (chunks.length > MAX_CHUNKS_PER_DOC) {
      chunks = chunks.slice(0, MAX_CHUNKS_PER_DOC);
    }

    if (chunks.length === 0) {
      skipped++;
      return;
    }

    // Generate embeddings
    const embeddings = await generateEmbeddings(chunks);

    // Insert chunks ONE BY ONE to avoid memory buildup
    for (let i = 0; i < chunks.length; i++) {
      const embeddingStr = `[${embeddings[i].join(',')}]`;
      
      await sql`
        INSERT INTO document_chunks (
          document_version_id, chunk_index, content, embedding,
          town, category, board, year
        ) VALUES (
          ${docVersion.id}, ${i}, ${chunks[i]}, ${embeddingStr}::vector,
          ${logicalDoc.town}, ${logicalDoc.category}, ${logicalDoc.board}, ${docVersion.year}
        )
      `;
      
      // Explicitly null out to help GC
      chunks[i] = null;
      embeddings[i] = null;
    }

    // Update job status
    await sql`
      UPDATE embedding_jobs
      SET status = 'completed', chunk_count = ${chunks.length}, completed_at = NOW()
      WHERE document_version_id = ${docVersion.id}
    `;

    processed++;
    totalChunks += chunks.length;
    
    // Null out everything
    chunks = null;
    embeddings.length = 0;
  } catch (error) {
    console.error(`❌ Failed doc ${docId}:`, error.message);
    failed++;
  }
}

async function migrate() {
  const sql = neon(DATABASE_URL);
  
  try {
    console.log(`🚀 Migrating town: ${TOWN}`);
    console.log(`GC available: ${typeof global.gc === 'function'}`);
    
    // Ensure indexes
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql`
      CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
      ON document_chunks 
      USING hnsw (embedding vector_cosine_ops)
    `;
    console.log('✅ Indexes ready\n');

    // Get document IDs
    const docs = await sql`
      SELECT dv.id 
      FROM document_versions dv
      JOIN logical_documents ld ON dv.document_id = ld.id
      WHERE ld.town = ${TOWN}
      AND dv.is_current = true
    `;

    const total = docs.length;
    console.log(`Found ${total} documents in ${TOWN}\n`);

    // Process one at a time
    for (let i = 0; i < total; i++) {
      await processDocument(sql, docs[i].id);
      
      // Force GC
      if ((i + 1) % GC_INTERVAL === 0 && global.gc) {
        global.gc();
        console.log(`  🗑️  Forced GC at doc ${i + 1}/${total}`);
      }
      
      // Progress
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
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

migrate();
