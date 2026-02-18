#!/usr/bin/env tsx
/**
 * Metadata Extraction Worker for V3 Pipeline
 * 
 * Processes uploaded documents:
 * 1. Downloads from S3
 * 2. Extracts metadata (category, board, year, meeting dates)
 * 3. Updates crawler_documents with metadata
 * 4. Marks for Gemini ingestion
 */

import { db, sql } from '../server/storage/db';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: S3_REGION });

interface ExtractionResult {
  processed: number;
  extracted: number;
  failed: number;
  skipped: number;
}

/**
 * Extract basic metadata from S3 key and filename
 * Enhanced version that doesn't require PDF content
 */
function extractMetadataFromPath(s3Key: string, url: string): {
  category: string | null;
  board: string | null;
  year: string | null;
} {
  const parts = s3Key.split('/');
  const filename = parts[parts.length - 1];
  
  // Category detection from path
  let category: string | null = null;
  const pathLower = s3Key.toLowerCase();
  
  if (pathLower.includes('/minutes/') || pathLower.includes('minutes') || filename.toLowerCase().includes('minutes')) {
    category = 'minutes';
  } else if (pathLower.includes('/agendas/') || pathLower.includes('agenda') || filename.toLowerCase().includes('agenda')) {
    category = 'agendas';
  } else if (pathLower.includes('/ordinances/') || pathLower.includes('ordinance')) {
    category = 'ordinances';
  } else if (pathLower.includes('/reports/') || pathLower.includes('report')) {
    category = 'reports';
  } else if (pathLower.includes('/budget/') || pathLower.includes('budget')) {
    category = 'budget';
  } else if (pathLower.includes('/forms/') || pathLower.includes('form')) {
    category = 'forms';
  } else if (pathLower.includes('/documents/')) {
    category = 'documents';
  }
  
  // Board detection from path or filename
  let board: string | null = null;
  const boardPatterns = [
    { pattern: /selectmen|select[-\s]?board/i, name: 'Board_of_Selectmen' },
    { pattern: /planning[-\s]?board|planning[-\s]?commission/i, name: 'Planning_Board' },
    { pattern: /zoning[-\s]?board|zba/i, name: 'Zoning_Board' },
    { pattern: /conservation[-\s]?commission/i, name: 'Conservation_Commission' },
    { pattern: /budget[-\s]?committee/i, name: 'Budget_Committee' },
    { pattern: /school[-\s]?board/i, name: 'School_Board' },
  ];
  
  for (const { pattern, name } of boardPatterns) {
    if (pattern.test(s3Key) || pattern.test(url)) {
      board = name;
      break;
    }
  }
  
  // Year detection from path or filename
  let year: string | null = null;
  const yearMatch = s3Key.match(/\/(\d{4})\//);
  if (yearMatch) {
    year = yearMatch[1];
  } else {
    // Try filename
    const filenameYearMatch = filename.match(/[-_\s]?(20\d{2})[-_\s\.]?/);
    if (filenameYearMatch) {
      year = filenameYearMatch[1];
    }
  }
  
  return { category, board, year };
}

/**
 * Process documents with status='uploaded'
 */
async function processUploadedDocuments(batchSize = 100): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    processed: 0,
    extracted: 0,
    failed: 0,
    skipped: 0
  };
  
  // Get uploaded documents that haven't been extracted yet
  const docs = await db.execute(sql`
    SELECT id, url, s3_key, filename
    FROM crawler_documents
    WHERE status = 'uploaded'
    AND (category IS NULL OR category = '')
    LIMIT ${batchSize}
  `);
  
  const rows = docs.rows as Array<{
    id: string;
    url: string;
    s3_key: string;
    filename: string;
  }>;
  
  if (rows.length === 0) {
    console.log('[MetadataExtraction] No documents to process');
    return result;
  }
  
  console.log(`[MetadataExtraction] Processing ${rows.length} documents...`);
  
  for (const doc of rows) {
    result.processed++;
    
    try {
      // Extract metadata from path (fast, no S3 download needed)
      const metadata = extractMetadataFromPath(doc.s3_key, doc.url);
      
      // Update document with metadata
      await db.execute(sql`
        UPDATE crawler_documents
        SET 
          category = ${metadata.category || 'documents'},
          board = ${metadata.board},
          year = ${metadata.year},
          updated_at = NOW()
        WHERE id = ${doc.id}
      `);
      
      const displayCategory = metadata.category || 'documents';
      const displayBoard = metadata.board || 'unknown';
      const displayYear = metadata.year || 'unknown';
      
      console.log(`[MetadataExtraction] ✅ ${doc.s3_key.split('/')[0]}: ${displayCategory}/${displayBoard}/${displayYear}`);
      result.extracted++;
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[MetadataExtraction] ❌ ${doc.s3_key}: ${errorMsg}`);
      result.failed++;
    }
  }
  
  return result;
}

/**
 * Get extraction statistics
 */
async function getExtractionStats(): Promise<{
  uploaded: number;
  needsExtraction: number;
  extracted: number;
}> {
  const stats = await db.execute(sql`
    SELECT
      SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) as uploaded,
      SUM(CASE WHEN status = 'uploaded' AND (category IS NULL OR category = '') THEN 1 ELSE 0 END) as needs_extraction,
      SUM(CASE WHEN status = 'uploaded' AND category IS NOT NULL AND category != '' THEN 1 ELSE 0 END) as extracted
    FROM crawler_documents
  `);
  
  const row = stats.rows[0] as any;
  
  return {
    uploaded: Number(row.uploaded) || 0,
    needsExtraction: Number(row.needs_extraction) || 0,
    extracted: Number(row.extracted) || 0
  };
}

/**
 * Main execution
 */
async function main() {
  const batchSize = 100;
  const delayMs = 1000; // 1 second between batches
  
  console.log('======================================================================');
  console.log('📋 Metadata Extraction - V3 Pipeline');
  console.log('======================================================================\n');
  
  const initialStats = await getExtractionStats();
  console.log(`📊 Initial Status:`);
  console.log(`   Uploaded:         ${initialStats.uploaded}`);
  console.log(`   Needs Extraction: ${initialStats.needsExtraction}`);
  console.log(`   Already Extracted: ${initialStats.extracted}\n`);
  
  if (initialStats.needsExtraction === 0) {
    console.log('✅ No documents need extraction. Exiting.\n');
    process.exit(0);
  }
  
  console.log(`🚀 Starting extraction...`);
  console.log(`   Batch size: ${batchSize}`);
  console.log(`   Delay: ${delayMs}ms\n`);
  
  let totalProcessed = 0;
  let totalExtracted = 0;
  let totalFailed = 0;
  let batchNum = 0;
  
  const startTime = Date.now();
  
  while (true) {
    batchNum++;
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📦 Batch ${batchNum}`);
    console.log('='.repeat(70));
    
    const result = await processUploadedDocuments(batchSize);
    
    if (result.processed === 0) {
      console.log('✅ No more documents to process\n');
      break;
    }
    
    totalProcessed += result.processed;
    totalExtracted += result.extracted;
    totalFailed += result.failed;
    
    const currentStats = await getExtractionStats();
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const rate = totalProcessed / (Date.now() - startTime) * 1000 * 60;
    
    console.log(`\n📊 Progress:`);
    console.log(`   Batch: ${result.extracted} extracted, ${result.failed} failed`);
    console.log(`   Total: ${totalExtracted} extracted, ${totalFailed} failed`);
    console.log(`   Remaining: ${currentStats.needsExtraction} documents`);
    console.log(`   Rate: ${rate.toFixed(1)} docs/min`);
    console.log(`   Elapsed: ${elapsed} minutes`);
    
    if (currentStats.needsExtraction > 0) {
      const eta = (currentStats.needsExtraction / rate).toFixed(1);
      console.log(`   ETA: ${eta} minutes`);
    }
    
    if (currentStats.needsExtraction > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const finalStats = await getExtractionStats();
  
  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 FINAL SUMMARY');
  console.log('='.repeat(70));
  console.log(`✅ Processed: ${totalProcessed} documents`);
  console.log(`📋 Extracted: ${totalExtracted} metadata records`);
  console.log(`❌ Failed: ${totalFailed}`);
  console.log(`⏱️  Duration: ${duration} minutes`);
  console.log(`⚡ Rate: ${(totalProcessed / parseFloat(duration)).toFixed(1)} docs/min\n`);
  
  console.log('📊 Final Database Status:');
  console.log(`   Total Uploaded:    ${finalStats.uploaded}`);
  console.log(`   Extracted:         ${finalStats.extracted}`);
  console.log(`   Needs Extraction:  ${finalStats.needsExtraction}\n`);
  
  process.exit(0);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
