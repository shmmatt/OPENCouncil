#!/usr/bin/env tsx
/**
 * Backfill S3 Documents to Database
 * 
 * Creates database records for existing S3 files that were uploaded
 * before state tracking was implemented.
 * 
 * For each S3 file:
 * - Parse metadata from path (category, board, year)
 * - Generate URL hash from S3 key (for deduplication)
 * - Create crawler_documents record with status='uploaded'
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getTown, recordDocument, type CrawlerTown } from '../server/services/crawlerState';
import * as crypto from 'crypto';

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

interface S3File {
  key: string;
  size: number;
  lastModified: Date;
}

interface BackfillStats {
  town: string;
  total: number;
  created: number;
  skipped: number;
  failed: number;
  errors: Array<{ key: string; error: string }>;
}

// ============================================================
// S3 Operations
// ============================================================

async function listS3Files(prefix: string): Promise<S3File[]> {
  const files: S3File[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await s3.send(command);

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && obj.Size && obj.LastModified) {
          // Skip directories
          if (!obj.Key.endsWith('/')) {
            files.push({
              key: obj.Key,
              size: obj.Size,
              lastModified: obj.LastModified,
            });
          }
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return files;
}

// ============================================================
// Metadata Parsing
// ============================================================

function parseS3Key(key: string): {
  town: string;
  category: string | null;
  board: string | null;
  year: string | null;
  filename: string;
} {
  // Expected format: town/category/board/year/filename
  // or variations: town/category/year/filename
  // or minimal: town/category/filename
  
  const parts = key.split('/');
  const filename = parts[parts.length - 1];
  const town = parts[0];
  
  let category: string | null = null;
  let board: string | null = null;
  let year: string | null = null;
  
  if (parts.length >= 2) {
    category = parts[1];
  }
  
  // Heuristic: if part looks like a year, it's a year
  // Otherwise it might be a board
  if (parts.length >= 3) {
    const part2 = parts[2];
    if (/^\d{4}$/.test(part2)) {
      // It's a year
      year = part2;
    } else if (part2 !== 'general' && part2 !== 'unknown') {
      // It's likely a board name
      board = part2;
    }
  }
  
  if (parts.length >= 4) {
    const part3 = parts[3];
    if (/^\d{4}$/.test(part3)) {
      year = part3;
    }
  }
  
  // Try to extract year from filename if not in path
  if (!year) {
    const filenameYearMatch = filename.match(/20\d{2}/);
    if (filenameYearMatch) {
      year = filenameYearMatch[0];
    }
  }
  
  return {
    town,
    category,
    board,
    year,
    filename,
  };
}

function hashS3Key(key: string): string {
  // Use S3 key as URL hash since we don't have original URLs
  // This allows deduplication by S3 key
  return crypto.createHash('sha256').update(key).digest('hex');
}

function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  
  const mimeTypes: Record<string, string> = {
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'txt': 'text/plain',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
  };
  
  return mimeTypes[ext || ''] || 'application/octet-stream';
}

// ============================================================
// Backfill Logic
// ============================================================

async function backfillTown(townSlug: string, dryRun: boolean = false): Promise<BackfillStats> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔄 Backfilling: ${townSlug}`);
  if (dryRun) {
    console.log(`   DRY RUN - No database changes`);
  }
  console.log(`${'='.repeat(70)}\n`);

  const stats: BackfillStats = {
    town: townSlug,
    total: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Get town from database
  const town = await getTown(townSlug);
  if (!town) {
    throw new Error(`Town "${townSlug}" not found in database`);
  }

  console.log(`📊 Town: ${town.name}`);
  console.log(`🆔 Town ID: ${town.id}\n`);

  // List S3 files
  console.log(`📦 Listing S3 files...`);
  const s3Prefix = `${townSlug}/`;
  const s3Files = await listS3Files(s3Prefix);
  stats.total = s3Files.length;
  console.log(`   Found ${s3Files.length} files\n`);

  if (s3Files.length === 0) {
    console.log(`⚠️  No files found in S3 for ${townSlug}\n`);
    return stats;
  }

  console.log(`💾 Creating database records...`);
  
  let progress = 0;
  const progressInterval = Math.max(1, Math.floor(s3Files.length / 20)); // Show ~20 progress updates

  for (const file of s3Files) {
    progress++;
    
    try {
      const metadata = parseS3Key(file.key);
      const urlHash = hashS3Key(file.key);
      
      if (!dryRun) {
        await recordDocument({
          townId: town.id,
          url: file.key, // Store S3 key as "url" since we don't have original
          urlHash,
          filename: metadata.filename,
          category: metadata.category,
          board: metadata.board,
          year: metadata.year,
          sizeBytes: file.size,
          mimeType: getMimeType(metadata.filename),
          s3Key: file.key,
          s3UploadedAt: file.lastModified,
          status: 'uploaded',
          contentValidated: true,
        });
      }
      
      stats.created++;
      
      if (progress % progressInterval === 0) {
        const percent = Math.round((progress / s3Files.length) * 100);
        process.stdout.write(`   [${percent}%] ${progress}/${s3Files.length} (${stats.created} created, ${stats.failed} failed)\r`);
      }
    } catch (error) {
      stats.failed++;
      stats.errors.push({
        key: file.key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      
      // Don't spam errors, just track them
      if (stats.errors.length <= 5) {
        console.error(`\n   ⚠️  Error: ${file.key} - ${error instanceof Error ? error.message : 'Unknown'}`);
      }
    }
  }
  
  console.log(`\n`);
  
  // Summary
  console.log(`${'='.repeat(70)}`);
  console.log(`📊 Summary: ${townSlug}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Total files:    ${stats.total}`);
  console.log(`Created:        ${stats.created} ✅`);
  console.log(`Skipped:        ${stats.skipped} ⊙`);
  console.log(`Failed:         ${stats.failed} ❌\n`);
  
  if (stats.errors.length > 0) {
    console.log(`⚠️  Errors (showing first 10):\n`);
    stats.errors.slice(0, 10).forEach(err => {
      console.log(`   ${err.key}`);
      console.log(`   → ${err.error}\n`);
    });
    
    if (stats.errors.length > 10) {
      console.log(`   ... and ${stats.errors.length - 10} more errors\n`);
    }
  }

  return stats;
}

async function backfillAllTowns(dryRun: boolean = false): Promise<Map<string, BackfillStats>> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔄 Batch Backfill - All Towns`);
  if (dryRun) {
    console.log(`   DRY RUN - No database changes`);
  }
  console.log(`${'='.repeat(70)}\n`);

  // List all S3 prefixes (towns)
  console.log(`📦 Discovering towns in S3...`);
  const command = new ListObjectsV2Command({
    Bucket: S3_BUCKET,
    Delimiter: '/',
  });

  const response = await s3.send(command);
  const townPrefixes = response.CommonPrefixes?.map(p => p.Prefix?.replace('/', '') || '').filter(Boolean) || [];
  
  console.log(`   Found ${townPrefixes.length} town folders\n`);

  const allStats = new Map<string, BackfillStats>();

  for (let i = 0; i < townPrefixes.length; i++) {
    const townSlug = townPrefixes[i];
    console.log(`\n[${i + 1}/${townPrefixes.length}] Processing ${townSlug}...`);

    try {
      const stats = await backfillTown(townSlug, dryRun);
      allStats.set(townSlug, stats);
    } catch (error) {
      console.error(`   ❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
      allStats.set(townSlug, {
        town: townSlug,
        total: 0,
        created: 0,
        skipped: 0,
        failed: 0,
        errors: [{ key: townSlug, error: error instanceof Error ? error.message : 'Unknown' }],
      });
    }
  }

  // Overall summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 Overall Summary`);
  console.log(`${'='.repeat(70)}\n`);

  let totalFiles = 0;
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const stats of allStats.values()) {
    totalFiles += stats.total;
    totalCreated += stats.created;
    totalSkipped += stats.skipped;
    totalFailed += stats.failed;
  }

  console.log(`Towns Processed:    ${allStats.size}`);
  console.log(`Total Files:        ${totalFiles}`);
  console.log(`Created:            ${totalCreated} ✅`);
  console.log(`Skipped:            ${totalSkipped} ⊙`);
  console.log(`Failed:             ${totalFailed} ❌\n`);

  const successRate = totalFiles > 0 ? Math.round((totalCreated / totalFiles) * 100) : 0;
  console.log(`Success Rate:       ${successRate}%\n`);

  // List towns with errors
  const townsWithErrors = Array.from(allStats.entries())
    .filter(([_, s]) => s.failed > 0)
    .sort((a, b) => b[1].failed - a[1].failed);

  if (townsWithErrors.length > 0) {
    console.log(`⚠️  Towns with Errors:\n`);
    console.log(`${'Town'.padEnd(20)} | ${'Failed'.padStart(8)} | ${'Total'.padStart(8)}`);
    console.log(`${'-'.repeat(20)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}`);
    
    for (const [town, stats] of townsWithErrors) {
      console.log(`${town.padEnd(20)} | ${String(stats.failed).padStart(8)} | ${String(stats.total).padStart(8)}`);
    }
    console.log(``);
  }

  return allStats;
}

// ============================================================
// CLI Interface
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
S3 to Database Backfill Tool

Populates crawler_documents table with existing S3 files.

Usage:
  npm run backfill:s3                    Backfill all towns
  npm run backfill:s3 <town-slug>        Backfill specific town
  npm run backfill:s3 --dry-run          Preview changes without writing
  npm run backfill:s3 <town> --dry-run   Preview specific town

Examples:
  npm run backfill:s3
  npm run backfill:s3 conway
  npm run backfill:s3 --dry-run
  npm run backfill:s3 conway --dry-run

Options:
  --help, -h        Show this help
  --all             Backfill all towns (default if no town specified)
  --dry-run         Preview without database changes
    `);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all') || args.length === 0 || (args.length === 1 && dryRun);

  if (all) {
    await backfillAllTowns(dryRun);
  } else {
    const townSlug = args.find(a => !a.startsWith('-'));
    if (!townSlug) {
      console.error('Error: Town slug required\n');
      console.log('Usage: npm run backfill:s3 <town-slug>');
      process.exit(1);
    }

    await backfillTown(townSlug, dryRun);
  }
  
  if (dryRun) {
    console.log(`\n💡 This was a dry run. Run without --dry-run to apply changes.\n`);
  } else {
    console.log(`\n✅ Backfill complete!\n`);
    console.log(`💡 Run verification to confirm:`);
    console.log(`   npm run verify:s3 -- --all\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
