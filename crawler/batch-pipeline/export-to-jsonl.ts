#!/usr/bin/env npx tsx
/**
 * Phase 1: Export file_blobs to JSONL for Gemini Batch API
 * 
 * Sources text directly from file_blobs (the source of truth for "files we possess").
 * Joins document_versions/logical_documents for metadata when available.
 * Writes file_blob_id into chunk keys for lineage tracking.
 * Updates file_blobs.embedding_status to 'exported' after processing.
 * 
 * Usage:
 *   npx tsx batch-pipeline/export-to-jsonl.ts [--town Ossipee] [--limit 100] [--force]
 *   --force: re-export files already marked as 'exported' or 'indexed'
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { sql, closeDb } from './utils/db';
import { chunkText, estimateTokens } from './utils/chunker';

const args = process.argv.slice(2);
const townArg = args.find(a => a.startsWith('--town='))?.split('=')[1]
  || (args.indexOf('--town') !== -1 ? args[args.indexOf('--town') + 1] : null);
const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
const limit = limitArg ? parseInt(limitArg, 10) : null;
const forceReexport = args.includes('--force');

const outputDir = path.join(process.cwd(), 'data');
const timestamp = new Date().toISOString().slice(0, 10);
const batchId = `batch-${timestamp}-${Date.now().toString(36)}`;
const suffix = townArg ? `-${townArg.toLowerCase()}` : '';
const outputFile = path.join(outputDir, `export${suffix}-${timestamp}.jsonl`);

let docCount = 0;
let chunkCount = 0;
let skippedCount = 0;
const processedBlobIds: string[] = [];

interface FileBlobRow {
  file_blob_id: string;
  preview_text: string | null;
  ocr_text: string | null;
  original_filename: string;
  content_hash: string | null;
  title: string | null;
  town: string | null;
  board: string | null;
  category: string | null;
  year: string | null;
  s3_key: string | null;
}

async function main() {
  console.log('OPENCouncil Batch Export Pipeline (file_blobs source)');
  console.log('=====================================================');
  console.log(`Batch ID: ${batchId}`);
  console.log(`Output: ${outputFile}`);
  if (townArg) console.log(`Filter: town = ${townArg}`);
  if (limit) console.log(`Limit: ${limit} file_blobs`);
  if (forceReexport) console.log(`Mode: FORCE re-export (including already exported/indexed)`);
  console.log('');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const writeStream = fs.createWriteStream(outputFile);

  const params: string[] = [];
  const conditions: string[] = [];

  if (!forceReexport) {
    conditions.push(`fb.embedding_status = 'none'`);
  }

  conditions.push(`(fb.ocr_text IS NOT NULL OR fb.preview_text IS NOT NULL)`);
  conditions.push(`(COALESCE(char_length(fb.ocr_text), 0) + COALESCE(char_length(fb.preview_text), 0)) > 100`);

  if (townArg) {
    params.push(townArg);
    conditions.push(`LOWER(COALESCE(ld.town, SPLIT_PART(fb.s3_key, '/', 1), 'unknown')) = LOWER($${params.length})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = limit ? `LIMIT ${limit}` : '';

  console.log('Streaming file_blobs from database...\n');

  const query = `
    SELECT 
      fb.id as file_blob_id,
      fb.preview_text,
      fb.ocr_text,
      fb.original_filename,
      fb.content_hash,
      fb.s3_key,
      ld.canonical_title as title,
      COALESCE(ld.town, SPLIT_PART(fb.s3_key, '/', 1)) as town,
      ld.board,
      ld.category,
      dv.year
    FROM file_blobs fb
    LEFT JOIN document_versions dv ON dv.file_blob_id = fb.id AND dv.is_current = true
    LEFT JOIN logical_documents ld ON dv.document_id = ld.id
    ${whereClause}
    ORDER BY COALESCE(ld.town, 'zzz'), fb.original_filename
    ${limitClause}
  `;

  const cursor = sql.unsafe(query, params).cursor(100);

  for await (const rows of cursor) {
    for (const row of rows as FileBlobRow[]) {
      const text = row.ocr_text || row.preview_text;

      if (!text || text.trim().length < 100) {
        skippedCount++;
        continue;
      }

      const chunks = chunkText(text);

      if (chunks.length === 0) {
        skippedCount++;
        continue;
      }

      const contentHash = row.content_hash || crypto.createHash('md5').update(text).digest('hex');

      docCount++;
      processedBlobIds.push(row.file_blob_id);

      const town = row.town || 'unknown';
      const category = row.category || 'general';
      const board = row.board || '';
      const year = row.year || '';
      const filename = row.original_filename || '';

      for (const chunk of chunks) {
        chunkCount++;

        // Key format: fileBlobId|chunkIndex|town|category|board|year|contentHash
        const key = [
          row.file_blob_id,
          chunk.index,
          town,
          category,
          board,
          year,
          contentHash,
        ].join('|');

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

      if (docCount % 100 === 0) {
        process.stdout.write(`\r  Processed ${docCount} files, ${chunkCount} chunks...`);
      }
    }
  }

  writeStream.end();

  // Mark processed file_blobs as 'exported' and set content_hash
  if (processedBlobIds.length > 0) {
    console.log(`\n\nUpdating ${processedBlobIds.length} file_blobs to embedding_status='exported'...`);

    const BATCH_SIZE = 500;
    for (let i = 0; i < processedBlobIds.length; i += BATCH_SIZE) {
      const batch = processedBlobIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map((_, idx) => `$${idx + 1}`).join(', ');
      await sql.unsafe(
        `UPDATE file_blobs 
         SET embedding_status = 'exported',
             content_hash = COALESCE(content_hash, md5(COALESCE(ocr_text, preview_text)))
         WHERE id IN (${placeholders})`,
        batch
      );
    }
  }

  // Log to embedding_jobs table
  await sql.unsafe(`
    INSERT INTO embedding_jobs (batch_id, status, file_blobs_processed, chunks_count, started_at, completed_at)
    VALUES ($1, 'exported', $2, $3, NOW(), NOW())
  `, [batchId, processedBlobIds.length, chunkCount]);

  await closeDb();

  console.log('\n\nExport complete!');
  console.log('==================');
  console.log(`Documents processed: ${docCount}`);
  console.log(`Chunks generated: ${chunkCount}`);
  console.log(`Skipped (no text): ${skippedCount}`);
  console.log(`Batch ID: ${batchId}`);
  console.log(`Output file: ${outputFile}`);

  if (fs.existsSync(outputFile)) {
    const stats = fs.statSync(outputFile);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`File size: ${sizeMB} MB`);
  }

  const estimatedCost = (chunkCount * 0.000004).toFixed(4);
  console.log(`Estimated batch cost: $${estimatedCost}`);

  console.log('\nNext step: Upload to Gemini Batch API');
  console.log('   See BATCH-API-GUIDE.md for instructions');
}

main().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
