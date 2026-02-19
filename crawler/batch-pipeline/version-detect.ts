#!/usr/bin/env npx tsx
/**
 * Version Detection & Stale Chunk Cleanup
 * 
 * Detects file_blobs whose content has changed since their last embedding.
 * When a document is re-downloaded with different content:
 *   1. Compare new content_hash vs the hash stored at embedding time
 *   2. Delete old chunks from document_chunks
 *   3. Reset file_blob embedding_status to 'none' so it gets re-exported
 * 
 * Also handles superseded document_versions:
 *   When a new version of a logical_document is created, old version's chunks
 *   should be removed and replaced by the new version's chunks.
 * 
 * Usage:
 *   npx tsx batch-pipeline/version-detect.ts [--dry-run] [--town Conway]
 */

import * as crypto from 'crypto';
import { sql, closeDb } from './utils/db';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const townArg = args.find(a => a.startsWith('--town='))?.split('=')[1]
  || (args.indexOf('--town') !== -1 ? args[args.indexOf('--town') + 1] : null);

interface StaleBlob {
  id: string;
  original_filename: string;
  old_content_hash: string;
  new_content_hash: string;
  chunk_count: number;
}

interface SupersededVersion {
  old_file_blob_id: string;
  new_file_blob_id: string;
  logical_doc_id: string;
  title: string;
  old_chunk_count: number;
}

async function detectContentHashChanges(): Promise<StaleBlob[]> {
  console.log('Checking for file_blobs with changed content...');

  const query = `
    SELECT 
      fb.id,
      fb.original_filename,
      fb.content_hash as old_content_hash,
      md5(COALESCE(fb.ocr_text, fb.preview_text)) as new_content_hash,
      fb.chunk_count
    FROM file_blobs fb
    WHERE fb.embedding_status = 'indexed'
      AND fb.content_hash IS NOT NULL
      AND (fb.ocr_text IS NOT NULL OR fb.preview_text IS NOT NULL)
      AND fb.content_hash != md5(COALESCE(fb.ocr_text, fb.preview_text))
  `;

  const results = await sql.unsafe(query);
  return results as StaleBlob[];
}

async function detectSupersededVersions(): Promise<SupersededVersion[]> {
  console.log('Checking for superseded document versions with stale chunks...');

  const conditions: string[] = [];
  const params: string[] = [];

  if (townArg) {
    params.push(townArg);
    conditions.push(`LOWER(ld.town) = LOWER($${params.length})`);
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  const query = `
    SELECT 
      old_dv.file_blob_id as old_file_blob_id,
      new_dv.file_blob_id as new_file_blob_id,
      ld.id as logical_doc_id,
      ld.canonical_title as title,
      COALESCE(old_fb.chunk_count, 0) as old_chunk_count
    FROM document_versions old_dv
    JOIN document_versions new_dv ON old_dv.document_id = new_dv.document_id AND new_dv.is_current = true
    JOIN logical_documents ld ON old_dv.document_id = ld.id
    LEFT JOIN file_blobs old_fb ON old_dv.file_blob_id = old_fb.id
    WHERE old_dv.is_current = false
      AND old_dv.file_blob_id != new_dv.file_blob_id
      AND old_dv.file_blob_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM document_chunks dc WHERE dc.file_blob_id = old_dv.file_blob_id
      )
      ${whereClause}
    ORDER BY ld.canonical_title
  `;

  const results = await sql.unsafe(query, params);
  return results as SupersededVersion[];
}

async function cleanupStaleChunks(fileBlobIds: string[], reason: string): Promise<number> {
  if (fileBlobIds.length === 0) return 0;

  if (dryRun) {
    const countResult = await sql.unsafe(
      `SELECT count(*) as cnt FROM document_chunks WHERE file_blob_id = ANY($1::text[])`,
      [fileBlobIds]
    );
    return parseInt(countResult[0]?.cnt || '0', 10);
  }

  const deleteResult = await sql.unsafe(
    `DELETE FROM document_chunks WHERE file_blob_id = ANY($1::text[]) RETURNING id`,
    [fileBlobIds]
  );

  await sql.unsafe(
    `UPDATE file_blobs 
     SET embedding_status = 'none', 
         chunk_count = 0, 
         embedded_at = NULL 
     WHERE id = ANY($1::text[])`,
    [fileBlobIds]
  );

  return deleteResult.length;
}

async function main() {
  console.log('OPENCouncil Version Detection & Cleanup');
  console.log('========================================');
  if (dryRun) console.log('MODE: DRY RUN (no changes will be made)');
  if (townArg) console.log(`Filter: town = ${townArg}`);
  console.log('');

  // Phase 1: Content hash changes
  const staleBlobs = await detectContentHashChanges();
  console.log(`Found ${staleBlobs.length} file_blobs with changed content\n`);

  if (staleBlobs.length > 0) {
    for (const blob of staleBlobs.slice(0, 10)) {
      console.log(`  - ${blob.original_filename}: ${blob.chunk_count} chunks to replace`);
      console.log(`    old hash: ${blob.old_content_hash?.slice(0, 16)}...`);
      console.log(`    new hash: ${blob.new_content_hash?.slice(0, 16)}...`);
    }
    if (staleBlobs.length > 10) {
      console.log(`  ... and ${staleBlobs.length - 10} more`);
    }

    const ids = staleBlobs.map(b => b.id);
    const deletedCount = await cleanupStaleChunks(ids, 'content_hash_changed');
    console.log(`\n${dryRun ? 'Would delete' : 'Deleted'} ${deletedCount} stale chunks from ${ids.length} file_blobs`);
  }

  // Phase 2: Superseded versions
  const superseded = await detectSupersededVersions();
  console.log(`\nFound ${superseded.length} superseded versions with stale chunks\n`);

  if (superseded.length > 0) {
    for (const sv of superseded.slice(0, 10)) {
      console.log(`  - ${sv.title}: ${sv.old_chunk_count} old chunks to remove`);
      console.log(`    old blob: ${sv.old_file_blob_id.slice(0, 8)}...`);
      console.log(`    new blob: ${sv.new_file_blob_id.slice(0, 8)}...`);
    }
    if (superseded.length > 10) {
      console.log(`  ... and ${superseded.length - 10} more`);
    }

    const oldBlobIds = superseded.map(sv => sv.old_file_blob_id);
    const deletedCount = await cleanupStaleChunks(oldBlobIds, 'version_superseded');
    console.log(`\n${dryRun ? 'Would delete' : 'Deleted'} ${deletedCount} stale chunks from ${oldBlobIds.length} superseded file_blobs`);
  }

  // Summary
  console.log('\n\nSummary');
  console.log('=======');

  const statusResult = await sql.unsafe(`
    SELECT embedding_status, count(*) as cnt 
    FROM file_blobs 
    GROUP BY embedding_status 
    ORDER BY cnt DESC
  `);
  console.log('\nFile blob embedding status:');
  for (const row of statusResult) {
    console.log(`  ${row.embedding_status}: ${row.cnt}`);
  }

  const chunkResult = await sql.unsafe('SELECT count(*) as cnt FROM document_chunks');
  console.log(`\nTotal chunks in pgvector: ${chunkResult[0]?.cnt}`);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run without --dry-run to apply changes.');
  }

  await closeDb();
}

main().catch(err => {
  console.error('Version detection failed:', err);
  process.exit(1);
});
