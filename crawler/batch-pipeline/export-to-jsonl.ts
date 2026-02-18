#!/usr/bin/env npx tsx
/**
 * Phase 1: Export documents to JSONL for Gemini Batch API
 * 
 * Streams documents from Neon, chunks them, and writes to .jsonl
 * No memory pressure - processes one document at a time
 * 
 * Usage:
 *   npx tsx batch-pipeline/export-to-jsonl.ts [--county carroll] [--town Ossipee]
 */

import * as fs from 'fs';
import * as path from 'path';
import { sql, closeDb } from './utils/db';
import { chunkText, estimateTokens } from './utils/chunker';

// Parse command line arguments
const args = process.argv.slice(2);
const countyArg = args.find(a => a.startsWith('--county='))?.split('=')[1] 
  || (args.indexOf('--county') !== -1 ? args[args.indexOf('--county') + 1] : null);
const townArg = args.find(a => a.startsWith('--town='))?.split('=')[1]
  || (args.indexOf('--town') !== -1 ? args[args.indexOf('--town') + 1] : null);
const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
const limit = limitArg ? parseInt(limitArg, 10) : null;

// Output file path
const outputDir = path.join(process.cwd(), 'data');
const timestamp = new Date().toISOString().slice(0, 10);
const suffix = townArg ? `-${townArg.toLowerCase()}` : (countyArg ? `-${countyArg.toLowerCase()}` : '');
const outputFile = path.join(outputDir, `export${suffix}-${timestamp}.jsonl`);

// Stats tracking
let docCount = 0;
let chunkCount = 0;
let skippedCount = 0;

interface DocumentRow {
  version_id: string;
  document_id: string;
  title: string;
  town: string;
  board: string | null;
  category: string;
  year: string | null;
  preview_text: string | null;
  ocr_text: string | null;
}

async function main() {
  console.log('🚀 OPENCouncil Batch Export Pipeline');
  console.log('====================================');
  console.log(`Output: ${outputFile}`);
  if (townArg) console.log(`Filter: town = ${townArg}`);
  if (countyArg) console.log(`Filter: county = ${countyArg}`);
  if (limit) console.log(`Limit: ${limit} documents`);
  console.log('');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Open output file for streaming writes
  const writeStream = fs.createWriteStream(outputFile);
  
  // Build query with filters
  let whereClause = '';
  const params: string[] = [];
  
  if (townArg) {
    params.push(townArg);
    whereClause = `WHERE LOWER(ld.town) = LOWER($${params.length})`;
  } else if (countyArg) {
    // For county filtering, we'd need a county mapping
    // For now, Carroll County is the only one with data
    whereClause = `WHERE ld.town != 'statewide'`;
  }

  const limitClause = limit ? `LIMIT ${limit}` : '';

  // Stream documents from database
  console.log('📖 Streaming documents from database...\n');
  
  const query = `
    SELECT 
      dv.id as version_id,
      dv.document_id,
      ld.canonical_title as title,
      ld.town,
      ld.board,
      ld.category,
      dv.year,
      fb.preview_text,
      fb.ocr_text
    FROM document_versions dv
    JOIN logical_documents ld ON dv.document_id = ld.id
    JOIN file_blobs fb ON dv.file_blob_id = fb.id
    WHERE dv.is_current = true
    ${whereClause ? 'AND ' + whereClause.replace('WHERE ', '') : ''}
    ORDER BY ld.town, ld.canonical_title
    ${limitClause}
  `;

  // Use cursor-based streaming
  const cursor = sql.unsafe(query, params).cursor(100);
  
  for await (const rows of cursor) {
    for (const row of rows as DocumentRow[]) {
      // Get text content (prefer OCR if available, fall back to preview)
      const text = row.ocr_text || row.preview_text;
      
      if (!text || text.trim().length < 100) {
        skippedCount++;
        continue;
      }

      // Chunk the text
      const chunks = chunkText(text);
      
      if (chunks.length === 0) {
        skippedCount++;
        continue;
      }

      docCount++;
      
      // Write each chunk as a JSONL line for Gemini Batch API
      for (const chunk of chunks) {
        chunkCount++;
        
        // Key format: versionId|chunkIndex|town|category
        // This lets us reconstruct metadata when importing results
        const key = `${row.version_id}|${chunk.index}|${row.town}|${row.category}|${row.board || ''}|${row.year || ''}`;
        
        const batchLine = {
          key,
          request: {
            content: {
              parts: [{ text: chunk.content }]
            }
          }
        };
        
        writeStream.write(JSON.stringify(batchLine) + '\n');
      }

      // Progress indicator
      if (docCount % 100 === 0) {
        process.stdout.write(`\r  Processed ${docCount} docs, ${chunkCount} chunks...`);
      }
    }
  }

  // Close streams
  writeStream.end();
  await closeDb();

  // Final stats
  console.log('\n\n✅ Export complete!');
  console.log('==================');
  console.log(`📄 Documents processed: ${docCount}`);
  console.log(`📦 Chunks generated: ${chunkCount}`);
  console.log(`⏭️  Skipped (no text): ${skippedCount}`);
  console.log(`📁 Output file: ${outputFile}`);
  
  // File size
  const stats = fs.statSync(outputFile);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
  console.log(`📊 File size: ${sizeMB} MB`);
  
  // Cost estimate
  const estimatedCost = (chunkCount * 0.000004).toFixed(4); // ~$0.004 per 1000 embeddings
  console.log(`💰 Estimated batch cost: $${estimatedCost}`);
  
  console.log('\n📋 Next step: Upload to Gemini Batch API');
  console.log('   See BATCH-API-GUIDE.md for instructions');
}

main().catch(err => {
  console.error('❌ Export failed:', err);
  process.exit(1);
});
