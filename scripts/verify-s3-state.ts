#!/usr/bin/env tsx
/**
 * S3 State Verification Tool
 * 
 * Compares S3 bucket contents with crawler_documents table
 * Identifies orphans, missing files, and reconciliation status
 */

import { S3Client, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getTown, getTownDocuments } from '../server/services/crawlerState';
import type { CrawlerDocument } from '../shared/crawler-schema';

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

interface VerificationReport {
  town: string;
  s3Total: number;
  dbTotal: number;
  matched: number;
  orphans: number;
  missing: number;
  orphanFiles: string[];
  missingFiles: string[];
  matchedFiles: string[];
  byCategory: Record<string, { s3: number; db: number; matched: number }>;
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

async function checkS3FileExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }));
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Verification Logic
// ============================================================

async function verifyTown(townSlug: string, verbose: boolean = false): Promise<VerificationReport> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔍 Verifying S3 State: ${townSlug}`);
  console.log(`${'='.repeat(70)}\n`);

  // Get town from database
  const town = await getTown(townSlug);
  if (!town) {
    throw new Error(`Town "${townSlug}" not found in database`);
  }

  console.log(`📊 Town: ${town.name}`);
  console.log(`🌐 URL: ${town.url}\n`);

  // List S3 files
  console.log(`📦 Listing S3 files...`);
  const s3Prefix = `${townSlug}/`;
  const s3Files = await listS3Files(s3Prefix);
  console.log(`   Found ${s3Files.length} files in S3\n`);

  // Get database documents
  console.log(`💾 Loading database records...`);
  const dbDocs = await getTownDocuments(town.id);
  console.log(`   Found ${dbDocs.length} documents in database\n`);

  // Build lookup maps
  const s3KeySet = new Set(s3Files.map(f => f.key));
  const dbKeySet = new Set(dbDocs.filter(d => d.s3Key).map(d => d.s3Key!));
  const dbKeyMap = new Map(dbDocs.filter(d => d.s3Key).map(d => [d.s3Key!, d]));

  // Find orphans (in S3, not in DB)
  const orphanFiles = s3Files
    .filter(f => !dbKeySet.has(f.key))
    .map(f => f.key);

  // Find missing (in DB, not in S3)
  const missingFiles = Array.from(dbKeySet)
    .filter(key => !s3KeySet.has(key));

  // Find matched
  const matchedFiles = Array.from(dbKeySet)
    .filter(key => s3KeySet.has(key));

  // Category breakdown
  const byCategory: Record<string, { s3: number; db: number; matched: number }> = {};

  // Count DB docs by category
  for (const doc of dbDocs) {
    const cat = doc.category || 'unknown';
    if (!byCategory[cat]) {
      byCategory[cat] = { s3: 0, db: 0, matched: 0 };
    }
    byCategory[cat].db++;
    
    if (doc.s3Key && s3KeySet.has(doc.s3Key)) {
      byCategory[cat].matched++;
    }
  }

  // Count S3 files by category (parse from path)
  for (const file of s3Files) {
    const parts = file.key.split('/');
    const cat = parts[1] || 'unknown';
    if (!byCategory[cat]) {
      byCategory[cat] = { s3: 0, db: 0, matched: 0 };
    }
    byCategory[cat].s3++;
  }

  const report: VerificationReport = {
    town: town.name,
    s3Total: s3Files.length,
    dbTotal: dbDocs.filter(d => d.s3Key).length,
    matched: matchedFiles.length,
    orphans: orphanFiles.length,
    missing: missingFiles.length,
    orphanFiles,
    missingFiles,
    matchedFiles,
    byCategory,
  };

  // Print summary
  console.log(`${'='.repeat(70)}`);
  console.log(`📊 Verification Summary`);
  console.log(`${'='.repeat(70)}\n`);

  console.log(`S3 Files:           ${report.s3Total}`);
  console.log(`DB Records:         ${report.dbTotal}`);
  console.log(`Matched:            ${report.matched} ✅`);
  console.log(`Orphans:            ${report.orphans} ⚠️  (in S3, not in DB)`);
  console.log(`Missing:            ${report.missing} ❌ (in DB, not in S3)\n`);

  // Reconciliation percentage
  const totalUnique = report.s3Total + report.missing;
  const reconciledPct = totalUnique > 0 
    ? Math.round((report.matched / totalUnique) * 100) 
    : 0;
  console.log(`Reconciliation:     ${reconciledPct}%\n`);

  // Category breakdown
  if (Object.keys(byCategory).length > 0) {
    console.log(`📁 By Category:\n`);
    const categories = Object.keys(byCategory).sort();
    
    console.log(`${'Category'.padEnd(20)} | ${'S3'.padStart(6)} | ${'DB'.padStart(6)} | ${'Match'.padStart(6)}`);
    console.log(`${'-'.repeat(20)}-+-${'-'.repeat(6)}-+-${'-'.repeat(6)}-+-${'-'.repeat(6)}`);
    
    for (const cat of categories) {
      const stats = byCategory[cat];
      console.log(`${cat.padEnd(20)} | ${String(stats.s3).padStart(6)} | ${String(stats.db).padStart(6)} | ${String(stats.matched).padStart(6)}`);
    }
    console.log(``);
  }

  // Detailed lists
  if (verbose || report.orphans > 0 || report.missing > 0) {
    if (report.orphans > 0) {
      console.log(`⚠️  Orphan Files (in S3, not in DB):\n`);
      orphanFiles.slice(0, 20).forEach(key => {
        console.log(`   ${key}`);
      });
      if (orphanFiles.length > 20) {
        console.log(`   ... and ${orphanFiles.length - 20} more\n`);
      } else {
        console.log(``);
      }
    }

    if (report.missing > 0) {
      console.log(`❌ Missing Files (in DB, not in S3):\n`);
      missingFiles.slice(0, 20).forEach(key => {
        const doc = dbKeyMap.get(key);
        const status = doc ? ` [${doc.status}]` : '';
        console.log(`   ${key}${status}`);
      });
      if (missingFiles.length > 20) {
        console.log(`   ... and ${missingFiles.length - 20} more\n`);
      } else {
        console.log(``);
      }
    }
  }

  // Recommendations
  console.log(`${'='.repeat(70)}`);
  console.log(`💡 Recommendations`);
  console.log(`${'='.repeat(70)}\n`);

  if (report.orphans > 0) {
    console.log(`⚠️  ${report.orphans} orphan files found in S3`);
    console.log(`   These files exist in S3 but have no database record.`);
    console.log(`   Possible causes:`);
    console.log(`   - Uploaded before state tracking was enabled`);
    console.log(`   - Manual uploads to S3`);
    console.log(`   - Database records deleted but S3 files remain\n`);
    console.log(`   Action: Review orphans and decide whether to:`);
    console.log(`   - Create database records (backfill)`);
    console.log(`   - Delete from S3 (cleanup)`);
    console.log(`   - Leave as-is (if intentional)\n`);
  }

  if (report.missing > 0) {
    console.log(`❌ ${report.missing} files missing from S3`);
    console.log(`   These are tracked in database but not in S3.`);
    console.log(`   Possible causes:`);
    console.log(`   - Upload failed but marked as uploaded`);
    console.log(`   - S3 files deleted manually`);
    console.log(`   - Wrong S3 key recorded\n`);
    console.log(`   Action: Review missing files and:`);
    console.log(`   - Re-upload from source if available`);
    console.log(`   - Mark as 'failed' in database`);
    console.log(`   - Remove stale database records\n`);
  }

  if (report.orphans === 0 && report.missing === 0) {
    console.log(`✅ Perfect match! S3 and database are fully reconciled.\n`);
  }

  return report;
}

// ============================================================
// Batch Verification
// ============================================================

async function verifyAllTowns(): Promise<Map<string, VerificationReport>> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔍 Batch S3 Verification - All Towns`);
  console.log(`${'='.repeat(70)}\n`);

  // List all S3 prefixes (towns)
  console.log(`📦 Discovering towns in S3...`);
  const command = new ListObjectsV2Command({
    Bucket: S3_BUCKET,
    Delimiter: '/',
  });

  const response = await s3.send(command);
  const townPrefixes = response.CommonPrefixes?.map(p => p.Prefix?.replace('/', '') || '').filter(Boolean) || [];
  
  console.log(`   Found ${townPrefixes.length} town folders in S3\n`);

  const reports = new Map<string, VerificationReport>();

  for (let i = 0; i < townPrefixes.length; i++) {
    const townSlug = townPrefixes[i];
    console.log(`[${i + 1}/${townPrefixes.length}] Processing ${townSlug}...`);

    try {
      const report = await verifyTown(townSlug, false);
      reports.set(townSlug, report);
    } catch (error) {
      console.error(`   ❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    }
  }

  // Overall summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 Overall Summary`);
  console.log(`${'='.repeat(70)}\n`);

  let totalS3 = 0;
  let totalDB = 0;
  let totalMatched = 0;
  let totalOrphans = 0;
  let totalMissing = 0;

  for (const report of reports.values()) {
    totalS3 += report.s3Total;
    totalDB += report.dbTotal;
    totalMatched += report.matched;
    totalOrphans += report.orphans;
    totalMissing += report.missing;
  }

  console.log(`Towns Processed:    ${reports.size}`);
  console.log(`Total S3 Files:     ${totalS3}`);
  console.log(`Total DB Records:   ${totalDB}`);
  console.log(`Matched:            ${totalMatched} ✅`);
  console.log(`Orphans:            ${totalOrphans} ⚠️`);
  console.log(`Missing:            ${totalMissing} ❌\n`);

  const totalUnique = totalS3 + totalMissing;
  const overallPct = totalUnique > 0 ? Math.round((totalMatched / totalUnique) * 100) : 0;
  console.log(`Overall Reconciliation: ${overallPct}%\n`);

  // List towns with issues
  const townsWithIssues = Array.from(reports.entries())
    .filter(([_, r]) => r.orphans > 0 || r.missing > 0)
    .sort((a, b) => (b[1].orphans + b[1].missing) - (a[1].orphans + a[1].missing));

  if (townsWithIssues.length > 0) {
    console.log(`⚠️  Towns with Discrepancies:\n`);
    console.log(`${'Town'.padEnd(20)} | ${'Orphans'.padStart(8)} | ${'Missing'.padStart(8)}`);
    console.log(`${'-'.repeat(20)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}`);
    
    for (const [town, report] of townsWithIssues) {
      console.log(`${town.padEnd(20)} | ${String(report.orphans).padStart(8)} | ${String(report.missing).padStart(8)}`);
    }
    console.log(``);
  }

  return reports;
}

// ============================================================
// CLI Interface
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
S3 State Verification Tool

Usage:
  npm run verify:s3                      Verify all towns
  npm run verify:s3 <town-slug>          Verify specific town
  npm run verify:s3 <town-slug> -v       Verbose mode (show all matched files)

Examples:
  npm run verify:s3
  npm run verify:s3 conway
  npm run verify:s3 ossipee -v
  npm run verify:s3 --all

Options:
  --help, -h        Show this help
  --all             Verify all towns (default if no town specified)
  -v, --verbose     Show detailed file lists
    `);
    return;
  }

  const verbose = args.includes('-v') || args.includes('--verbose');
  const all = args.includes('--all') || args.length === 0 || (args.length === 1 && verbose);

  if (all) {
    await verifyAllTowns();
  } else {
    const townSlug = args.find(a => !a.startsWith('-'));
    if (!townSlug) {
      console.error('Error: Town slug required\n');
      console.log('Usage: npm run verify:s3 <town-slug>');
      process.exit(1);
    }

    await verifyTown(townSlug, verbose);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
