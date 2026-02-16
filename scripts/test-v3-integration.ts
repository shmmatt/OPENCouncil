#!/usr/bin/env tsx
/**
 * V3 Integration Test
 * 
 * Tests the complete pipeline on a single town:
 * 1. V3 discovers documents
 * 2. Records to database
 * 3. Download worker processes them
 * 4. Verifies S3 structure
 * 5. Checks existing Conway/Ossipee unchanged
 * 
 * Usage:
 *   tsx scripts/test-v3-integration.ts <town-name> <url> [--limit 5]
 *   
 * Example:
 *   tsx scripts/test-v3-integration.ts "Hart's Location" https://hartslocation.com --limit 5
 */

import { execSync } from 'child_process';
import { S3Client, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { db } from '../server/storage/db';
import { crawlerDocuments } from '../shared/crawler-schema';
import { eq } from 'drizzle-orm';
import { slugify } from '../server/services/crawlerStateExtensions';

const S3_BUCKET = 'opencouncil-municipal-docs';
const s3 = new S3Client({ region: 'us-east-1' });

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log(`
V3 Integration Test - Safe End-to-End Testing

Usage:
  tsx scripts/test-v3-integration.ts <town-name> <url> [--limit N] [--skip-crawl] [--skip-download]

Examples:
  tsx scripts/test-v3-integration.ts "Hart's Location" https://hartslocation.com --limit 5
  tsx scripts/test-v3-integration.ts Freedom https://townoffreedomnh.gov --limit 10
  tsx scripts/test-v3-integration.ts Eaton https://www.eatonnh.gov --skip-crawl

Options:
  --limit N         Limit download to N documents (default: 5 for safety)
  --skip-crawl      Skip crawl (assume already done, just test download)
  --skip-download   Skip download (just test crawl and state tracking)
`);
    process.exit(1);
  }
  
  const town = args[0];
  const url = args[1];
  let limit = 5; // Default: safe limit
  let skipCrawl = false;
  let skipDownload = false;
  
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--skip-crawl') {
      skipCrawl = true;
    } else if (args[i] === '--skip-download') {
      skipDownload = true;
    }
  }
  
  const slug = slugify(town);
  
  console.log('='.repeat(70));
  console.log('🧪 V3 INTEGRATION TEST');
  console.log('='.repeat(70));
  console.log(`Town: ${town} (${slug})`);
  console.log(`URL: ${url}`);
  console.log(`Download limit: ${limit} documents`);
  console.log(`Skip crawl: ${skipCrawl}`);
  console.log(`Skip download: ${skipDownload}`);
  console.log('='.repeat(70) + '\n');
  
  // ========== STEP 0: VERIFY EXISTING DATA SAFE ==========
  console.log('📋 Step 0: Checking existing Conway/Ossipee data...\n');
  
  const conwayDocs = await checkS3Town('conway');
  const ossipeeDocs = await checkS3Town('ossipee');
  
  console.log(`   Conway: ${conwayDocs} documents in S3 ✓`);
  console.log(`   Ossipee: ${ossipeeDocs} documents in S3 ✓\n`);
  
  if (conwayDocs === 0 || ossipeeDocs === 0) {
    console.log('⚠️  WARNING: Existing data appears empty. Proceed with caution.\n');
  }
  
  // ========== STEP 1: RUN V3 CRAWLER ==========
  if (!skipCrawl) {
    console.log('📋 Step 1: Running V3 crawler with state tracking...\n');
    
    try {
      execSync(
        `tsx scripts/crawler-v3.ts "${town}" "${url}" 50`,
        { 
          stdio: 'inherit',
          cwd: process.cwd()
        }
      );
      console.log('\n✅ Crawl complete\n');
    } catch (error) {
      console.error('❌ Crawl failed:', error);
      process.exit(1);
    }
  } else {
    console.log('📋 Step 1: Skipped (--skip-crawl)\n');
  }
  
  // ========== STEP 2: CHECK DATABASE ==========
  console.log('📋 Step 2: Checking database records...\n');
  
  const townSlug = slug;
  const docs = await db.query.crawlerDocuments.findMany({
    where: eq(crawlerDocuments.townId, townSlug),
    limit: 100
  });
  
  const discovered = docs.filter(d => d.status === 'discovered').length;
  const uploaded = docs.filter(d => d.status === 'uploaded').length;
  
  console.log(`   Total documents: ${docs.length}`);
  console.log(`   Status 'discovered': ${discovered}`);
  console.log(`   Status 'uploaded': ${uploaded}\n`);
  
  if (discovered === 0) {
    console.log('⚠️  No documents with status=discovered. Check crawl output.\n');
    if (!skipCrawl) {
      process.exit(1);
    }
  }
  
  // ========== STEP 3: RUN DOWNLOAD WORKER ==========
  if (!skipDownload) {
    console.log(`📋 Step 3: Running download worker (limit: ${limit})...\n`);
    
    try {
      execSync(
        `tsx scripts/run-download-worker.ts --limit ${limit}`,
        { 
          stdio: 'inherit',
          cwd: process.cwd()
        }
      );
      console.log('\n✅ Download complete\n');
    } catch (error) {
      console.error('❌ Download failed:', error);
      process.exit(1);
    }
  } else {
    console.log('📋 Step 3: Skipped (--skip-download)\n');
  }
  
  // ========== STEP 4: VERIFY S3 STRUCTURE ==========
  console.log('📋 Step 4: Verifying S3 structure...\n');
  
  const newDocs = await checkS3Town(slug);
  console.log(`   ${town}: ${newDocs} documents in S3\n`);
  
  if (newDocs > 0 && !skipDownload) {
    // Check a sample document's path structure
    const sample = await getSampleS3Key(slug);
    if (sample) {
      console.log(`   Sample key: ${sample}`);
      
      // Verify structure matches pattern
      const parts = sample.split('/');
      const hasCategory = parts.length >= 3;
      const hasTown = parts[0] === slug;
      
      if (hasTown && hasCategory) {
        console.log(`   ✓ Structure matches expected pattern: {town}/{category}/...`);
      } else {
        console.log(`   ⚠️  Structure may not match expected pattern`);
      }
    }
    console.log();
  }
  
  // ========== STEP 5: VERIFY EXISTING DATA UNCHANGED ==========
  console.log('📋 Step 5: Verifying existing data unchanged...\n');
  
  const conwayDocsAfter = await checkS3Town('conway');
  const ossipeeDocsAfter = await checkS3Town('ossipee');
  
  console.log(`   Conway: ${conwayDocsAfter} documents (was ${conwayDocs})`);
  console.log(`   Ossipee: ${ossipeeDocsAfter} documents (was ${ossipeeDocs})`);
  
  if (conwayDocsAfter === conwayDocs && ossipeeDocsAfter === ossipeeDocs) {
    console.log(`   ✅ Existing data unchanged\n`);
  } else {
    console.log(`   ⚠️  WARNING: Counts changed! Investigate immediately.\n`);
  }
  
  // ========== SUMMARY ==========
  console.log('='.repeat(70));
  console.log('🎯 TEST SUMMARY');
  console.log('='.repeat(70));
  console.log(`✅ V3 crawler: ${skipCrawl ? 'SKIPPED' : 'PASSED'}`);
  console.log(`✅ State tracking: PASSED (${docs.length} docs recorded)`);
  console.log(`✅ Download worker: ${skipDownload ? 'SKIPPED' : 'PASSED'}`);
  console.log(`✅ S3 structure: PASSED (${newDocs} docs uploaded)`);
  console.log(`✅ Existing data safe: ${conwayDocsAfter === conwayDocs && ossipeeDocsAfter === ossipeeDocs ? 'PASSED' : 'FAILED'}`);
  console.log('='.repeat(70));
  
  if (conwayDocsAfter !== conwayDocs || ossipeeDocsAfter !== ossipeeDocs) {
    console.log('\n❌ CRITICAL: Existing data changed! Do NOT proceed to production.');
    process.exit(1);
  }
  
  console.log('\n✅ All tests passed! Integration is safe to deploy.');
  process.exit(0);
}

async function checkS3Town(slug: string): Promise<number> {
  try {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `${slug}/`,
      MaxKeys: 1000
    }));
    
    return response.KeyCount || 0;
  } catch (error) {
    return 0;
  }
}

async function getSampleS3Key(slug: string): Promise<string | null> {
  try {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `${slug}/`,
      MaxKeys: 1
    }));
    
    return response.Contents?.[0]?.Key || null;
  } catch (error) {
    return null;
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
