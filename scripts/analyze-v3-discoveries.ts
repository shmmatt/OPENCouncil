#!/usr/bin/env tsx
/**
 * Analyze V3 Discovery Results vs Existing S3/DB
 * 
 * Compares V3 crawler discoveries against:
 * - Existing S3 files (12,181 total)
 * - Database records (12,179 total)
 * 
 * Determines:
 * - How many V3 discoveries are NEW
 * - How many are duplicates (already in S3)
 * - Breakdown by town
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getTownDocuments, getTown } from '../server/services/crawlerState';
import { hashUrl } from '../server/services/crawlerState';

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

interface V3Result {
  town: string;
  url: string;
  documentsFound: number;
  documents: string[];
}

interface TownAnalysis {
  town: string;
  v3Discovered: number;
  inS3: number;
  inDB: number;
  newDocs: number;
  duplicates: number;
  duplicateRate: number;
  newDocUrls: string[];
}

async function listS3Files(prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
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
        if (obj.Key && !obj.Key.endsWith('/')) {
          keys.add(obj.Key);
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

async function analyzeTown(v3Result: V3Result): Promise<TownAnalysis> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 Analyzing: ${v3Result.town}`);
  console.log(`${'='.repeat(70)}`);
  
  const townSlug = v3Result.town.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  
  // Get S3 files
  console.log(`📦 Loading S3 files for ${townSlug}...`);
  const s3Keys = await listS3Files(`${townSlug}/`);
  console.log(`   Found ${s3Keys.size} files in S3`);
  
  // Get DB records
  console.log(`💾 Loading database records...`);
  let dbUrlHashes = new Set<string>();
  try {
    const town = await getTown(townSlug);
    if (town) {
      const dbDocs = await getTownDocuments(town.id);
      dbUrlHashes = new Set(dbDocs.map(d => d.urlHash));
      console.log(`   Found ${dbDocs.length} documents in database`);
    } else {
      console.log(`   Town not found in database`);
    }
  } catch (error) {
    console.log(`   Error loading DB: ${error}`);
  }
  
  // Analyze V3 discoveries
  console.log(`🔍 Analyzing ${v3Result.documentsFound} V3 discoveries...`);
  
  let inS3 = 0;
  let inDB = 0;
  const newDocUrls: string[] = [];
  
  for (const docUrl of v3Result.documents) {
    const urlHash = hashUrl(docUrl);
    const filename = path.basename(new URL(docUrl).pathname);
    
    // Check if URL already in DB (most reliable)
    if (dbUrlHashes.has(urlHash)) {
      inDB++;
      continue;
    }
    
    // Check if filename exists in S3 (less reliable, but catches manual uploads)
    let foundInS3 = false;
    for (const s3Key of s3Keys) {
      if (s3Key.endsWith(filename)) {
        foundInS3 = true;
        inS3++;
        break;
      }
    }
    
    if (!foundInS3) {
      newDocUrls.push(docUrl);
    }
  }
  
  const duplicates = inDB + inS3;
  const newDocs = v3Result.documentsFound - duplicates;
  const duplicateRate = v3Result.documentsFound > 0 
    ? (duplicates / v3Result.documentsFound) * 100 
    : 0;
  
  const analysis: TownAnalysis = {
    town: v3Result.town,
    v3Discovered: v3Result.documentsFound,
    inS3: inS3,
    inDB: inDB,
    newDocs,
    duplicates,
    duplicateRate,
    newDocUrls
  };
  
  // Print results
  console.log(`\n📊 Results:`);
  console.log(`   V3 Discovered:  ${analysis.v3Discovered}`);
  console.log(`   Already in DB:  ${analysis.inDB} (${((analysis.inDB / analysis.v3Discovered) * 100).toFixed(1)}%)`);
  console.log(`   Only in S3:     ${analysis.inS3} (${((analysis.inS3 / analysis.v3Discovered) * 100).toFixed(1)}%)`);
  console.log(`   Truly NEW:      ${analysis.newDocs} (${((analysis.newDocs / analysis.v3Discovered) * 100).toFixed(1)}%)`);
  console.log(`   Duplicate Rate: ${analysis.duplicateRate.toFixed(1)}%`);
  
  if (analysis.newDocs > 0 && analysis.newDocs <= 10) {
    console.log(`\n📄 New Documents:`);
    newDocUrls.forEach(url => console.log(`   ${url}`));
  } else if (analysis.newDocs > 10) {
    console.log(`\n📄 New Documents (sample):`);
    newDocUrls.slice(0, 10).forEach(url => console.log(`   ${url}`));
    console.log(`   ... and ${analysis.newDocs - 10} more`);
  }
  
  return analysis;
}

async function analyzeAll(): Promise<void> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔍 V3 Discovery Analysis - All Towns`);
  console.log(`${'='.repeat(70)}`);
  
  // Load all V3 results
  const logsDir = path.join(process.cwd(), 'crawl-logs');
  const files = await fs.readdir(logsDir);
  const v3Files = files.filter(f => f.startsWith('v3-') && f.endsWith('.json'));
  
  console.log(`\n📁 Found ${v3Files.length} V3 crawl results\n`);
  
  const analyses: TownAnalysis[] = [];
  
  for (let i = 0; i < v3Files.length; i++) {
    const file = v3Files[i];
    const filePath = path.join(logsDir, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const v3Result: V3Result = JSON.parse(content);
    
    console.log(`\n[${i + 1}/${v3Files.length}] Processing ${v3Result.town}...`);
    
    try {
      const analysis = await analyzeTown(v3Result);
      analyses.push(analysis);
    } catch (error) {
      console.error(`   ❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }
  
  // Overall summary
  console.log(`\n\n${'='.repeat(70)}`);
  console.log(`📊 OVERALL SUMMARY`);
  console.log(`${'='.repeat(70)}\n`);
  
  const totalV3 = analyses.reduce((sum, a) => sum + a.v3Discovered, 0);
  const totalInDB = analyses.reduce((sum, a) => sum + a.inDB, 0);
  const totalInS3 = analyses.reduce((sum, a) => sum + a.inS3, 0);
  const totalNew = analyses.reduce((sum, a) => sum + a.newDocs, 0);
  const totalDuplicates = totalInDB + totalInS3;
  const overallDuplicateRate = totalV3 > 0 ? (totalDuplicates / totalV3) * 100 : 0;
  
  console.log(`Total V3 Discoveries:   ${totalV3}`);
  console.log(`Already in Database:    ${totalInDB} (${((totalInDB / totalV3) * 100).toFixed(1)}%)`);
  console.log(`Only in S3:             ${totalInS3} (${((totalInS3 / totalV3) * 100).toFixed(1)}%)`);
  console.log(`Truly NEW:              ${totalNew} (${((totalNew / totalV3) * 100).toFixed(1)}%)`);
  console.log(`Overall Duplicate Rate: ${overallDuplicateRate.toFixed(1)}%\n`);
  
  // Town breakdown
  console.log(`📁 By Town:\n`);
  console.log(`${'Town'.padEnd(20)} | ${'V3'.padStart(6)} | ${'InDB'.padStart(6)} | ${'InS3'.padStart(6)} | ${'NEW'.padStart(6)} | ${'Dup%'.padStart(6)}`);
  console.log(`${'-'.repeat(20)}-+-${'-'.repeat(6)}-+-${'-'.repeat(6)}-+-${'-'.repeat(6)}-+-${'-'.repeat(6)}-+-${'-'.repeat(6)}`);
  
  for (const analysis of analyses.sort((a, b) => b.newDocs - a.newDocs)) {
    const dupPct = analysis.duplicateRate.toFixed(1);
    console.log(
      `${analysis.town.padEnd(20)} | ${String(analysis.v3Discovered).padStart(6)} | ` +
      `${String(analysis.inDB).padStart(6)} | ${String(analysis.inS3).padStart(6)} | ` +
      `${String(analysis.newDocs).padStart(6)} | ${dupPct.padStart(6)}`
    );
  }
  
  // Save results
  const reportPath = path.join(logsDir, `v3-analysis-${Date.now()}.json`);
  await fs.writeFile(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      totalV3,
      totalInDB,
      totalInS3,
      totalNew,
      totalDuplicates,
      overallDuplicateRate
    },
    towns: analyses
  }, null, 2));
  
  console.log(`\n💾 Full report saved: ${reportPath}\n`);
}

// CLI
async function main() {
  await analyzeAll();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
