#!/usr/bin/env tsx
/**
 * Batch Universal Document Crawler V2
 * 
 * Runs V2 crawler on all Carroll County towns
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

interface Town {
  name: string;
  url: string;
}

const ALL_CARROLL_COUNTY_TOWNS: Town[] = [
  { name: 'Albany', url: 'https://albanynh.org' },
  { name: 'Bartlett', url: 'https://www.townofbartlett.nh.gov' },
  { name: 'Brookfield', url: 'https://www.brookfieldnh.gov' },
  { name: 'Chatham', url: 'https://www.chathamnh.org' },
  { name: 'Conway', url: 'https://conwaynh.gov' },
  { name: 'Eaton', url: 'https://www.eatonnh.gov' },
  { name: 'Effingham', url: 'https://effinghamnh.net' },
  { name: 'Freedom', url: 'https://townoffreedomnh.gov' },
  { name: "Hart's Location", url: 'https://hartslocation.com' },
  { name: 'Jackson', url: 'https://www.jackson-nh.gov' },
  { name: 'Madison', url: 'https://madison-nh.org' },
  { name: 'Moultonborough', url: 'https://moultonboroughnh.gov' },
  { name: 'Ossipee', url: 'https://www.ossipee.org' },
  { name: 'Sandwich', url: 'https://www.sandwichnh.com' },
  { name: 'Tamworth', url: 'https://tamworthnh.gov' },
  { name: 'Tuftonboro', url: 'https://www.tuftonboronh.gov' },
  { name: 'Wakefield', url: 'https://www.wakefieldnh.gov' },
  { name: 'Wolfeboro', url: 'https://www.wolfeboronh.us' },
];

// Skip Hart's Location (shell escaping bug)
const CARROLL_COUNTY_TOWNS = ALL_CARROLL_COUNTY_TOWNS.filter(t => t.name !== "Hart's Location");

// WordPress towns need longer timeout
const WORDPRESS_TOWNS = ['Albany', 'Chatham', 'Effingham', 'Freedom', 'Jackson', 'Madison', 'Sandwich', 'Tamworth', "Hart's Location"];

interface TownResult {
  name: string;
  url: string;
  success: boolean;
  docsFound: number;
  error?: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
}

async function crawlTown(town: Town, dryRun: boolean = false, queueUpload: boolean = false, resume: boolean = false): Promise<TownResult> {
  const startTime = new Date();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🏛️  Crawling: ${town.name}`);
  console.log(`🌐 URL: ${town.url}`);
  console.log(`⏰ Started: ${startTime.toISOString()}`);
  console.log(`${'='.repeat(70)}\n`);

  return new Promise((resolve) => {
    const args = [
      'run',
      'crawl:universal:v2',
      '--',
      '--town',
      town.name,
      '--url',
      town.url,
      '--max-pages',
      '200', // Increased from 100 for better coverage
    ];

    if (dryRun) {
      args.push('--dry-run');
    }
    
    if (queueUpload) {
      args.push('--queue-upload');
    }
    
    if (resume) {
      args.push('--resume');
    }

    const proc = spawn('npm', args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: true,
    });

    // WordPress towns need longer timeout (larger sitemaps)
    const isWordPress = WORDPRESS_TOWNS.includes(town.name);
    const timeoutMinutes = isWordPress ? 30 : 20;
    const timeoutMs = timeoutMinutes * 60 * 1000;

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      console.log(`\n⏰ Timeout: ${town.name} exceeded ${timeoutMinutes} minutes, skipping...`);
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const endTime = new Date();
      const duration = (endTime.getTime() - startTime.getTime()) / 1000 / 60;

      const result: TownResult = {
        name: town.name,
        url: town.url,
        success: code === 0 && !timedOut,
        docsFound: 0, // Will be parsed from logs if needed
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationMinutes: Math.round(duration * 10) / 10,
      };

      if (timedOut) {
        const isWordPress = WORDPRESS_TOWNS.includes(town.name);
        const timeoutMinutes = isWordPress ? 30 : 20;
        result.error = `Timeout (${timeoutMinutes} minutes)`;
      } else if (code !== 0) {
        result.error = `Exit code ${code}`;
      }

      console.log(`\n✅ Completed: ${town.name} (${duration.toFixed(1)} min)\n`);
      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      const endTime = new Date();
      const duration = (endTime.getTime() - startTime.getTime()) / 1000 / 60;

      resolve({
        name: town.name,
        url: town.url,
        success: false,
        docsFound: 0,
        error: err.message,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationMinutes: Math.round(duration * 10) / 10,
      });
    });
  });
}

interface BatchCheckpoint {
  completedTowns: string[];
  inProgressTown: string | null;
  timestamp: string;
}

const BATCH_CHECKPOINT_PATH = path.join(process.cwd(), 'checkpoints', 'batch-checkpoint.json');

async function saveBatchCheckpoint(checkpoint: BatchCheckpoint): Promise<void> {
  try {
    await fs.mkdir(path.dirname(BATCH_CHECKPOINT_PATH), { recursive: true });
    await fs.writeFile(BATCH_CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
  } catch (error) {
    console.error('Failed to save batch checkpoint:', error);
  }
}

async function loadBatchCheckpoint(): Promise<BatchCheckpoint | null> {
  try {
    const content = await fs.readFile(BATCH_CHECKPOINT_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function deleteBatchCheckpoint(): Promise<void> {
  try {
    await fs.unlink(BATCH_CHECKPOINT_PATH);
  } catch {
    // Ignore if doesn't exist
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const skipExisting = process.argv.includes('--skip-existing');
  const resume = process.argv.includes('--resume');
  const queueUpload = process.argv.includes('--queue-upload');

  console.log('\n' + '='.repeat(70));
  console.log('📄 BATCH UNIVERSAL DOCUMENT CRAWLER V2 - SITEMAP FIX ENABLED');
  console.log('='.repeat(70));
  console.log(`🏛️  Towns: ${CARROLL_COUNTY_TOWNS.length} (Hart's Location excluded - shell bug)`);
  console.log(`🔍 Mode: ${dryRun ? 'DRY RUN' : 'FULL CRAWL WITH UPLOAD'}`);
  console.log(`📊 Page limit: 200 per town (increased from 100)`);
  console.log(`⏱️  Timeout: 30 min (WordPress) / 20 min (others)`);
  if (resume) {
    console.log(`🔄 Resume: Enabled`);
  }
  if (queueUpload) {
    console.log(`📦 Upload: Queued for service`);
  }
  console.log(`⏰ Started: ${new Date().toISOString()}`);
  console.log(`🎯 Expected time: ~6 hours for ${CARROLL_COUNTY_TOWNS.length} towns`);
  console.log('='.repeat(70) + '\n');

  // Load batch checkpoint if resuming
  let checkpoint: BatchCheckpoint | null = null;
  let completedTowns = new Set<string>();
  
  if (resume) {
    checkpoint = await loadBatchCheckpoint();
    if (checkpoint) {
      completedTowns = new Set(checkpoint.completedTowns);
      console.log(`✅ Resuming from checkpoint: ${completedTowns.size} towns already completed`);
      console.log(`   Skipping: ${Array.from(completedTowns).join(', ')}\n`);
    } else {
      console.log(`ℹ️  No batch checkpoint found, starting from beginning\n`);
    }
  }

  const results: TownResult[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < CARROLL_COUNTY_TOWNS.length; i++) {
    const town = CARROLL_COUNTY_TOWNS[i];
    
    // Skip if already completed
    if (completedTowns.has(town.name)) {
      console.log(`\n[${i + 1}/${CARROLL_COUNTY_TOWNS.length}] ⏭️  Skipping ${town.name} (already completed)\n`);
      continue;
    }
    
    console.log(`\n[${i + 1}/${CARROLL_COUNTY_TOWNS.length}] Starting ${town.name}...\n`);
    
    // Save batch checkpoint before starting town
    if (resume) {
      await saveBatchCheckpoint({
        completedTowns: Array.from(completedTowns),
        inProgressTown: town.name,
        timestamp: new Date().toISOString()
      });
    }

    const result = await crawlTown(town, dryRun, queueUpload, resume);
    results.push(result);

    if (result.success) {
      successCount++;
      completedTowns.add(town.name);
      
      // Update batch checkpoint after success
      if (resume) {
        await saveBatchCheckpoint({
          completedTowns: Array.from(completedTowns),
          inProgressTown: null,
          timestamp: new Date().toISOString()
        });
      }
    } else {
      failCount++;
      console.error(`❌ Failed: ${town.name} - ${result.error}`);
    }

    // Small delay between towns
    if (i < CARROLL_COUNTY_TOWNS.length - 1) {
      console.log('\n⏳ Waiting 5 seconds before next town...\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Delete batch checkpoint on successful completion
  if (resume && failCount === 0) {
    await deleteBatchCheckpoint();
    console.log('\n✅ Batch checkpoint deleted (all towns completed)\n');
  }
  
  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 BATCH CRAWL SUMMARY');
  console.log('='.repeat(70));
  console.log(`✅ Successful: ${successCount}/${CARROLL_COUNTY_TOWNS.length}`);
  console.log(`❌ Failed: ${failCount}/${CARROLL_COUNTY_TOWNS.length}`);
  console.log(`📈 Success Rate: ${Math.round((successCount / CARROLL_COUNTY_TOWNS.length) * 100)}%`);

  const totalTime = results.reduce((sum, r) => sum + r.durationMinutes, 0);
  console.log(`⏱️  Total Time: ${Math.round(totalTime)} minutes`);
  console.log(`⏰ Completed: ${new Date().toISOString()}`);

  console.log('\n📋 Individual Results:\n');
  results.forEach((result, i) => {
    const status = result.success ? '✅' : '❌';
    const error = result.error ? ` (${result.error})` : '';
    console.log(`${i + 1}. ${status} ${result.name} - ${result.durationMinutes} min${error}`);
  });

  // Save results to JSON
  const timestamp = new Date().toISOString().split('T')[0];
  const resultsPath = path.join(process.cwd(), 'crawl-logs', `v2-batch-results-${timestamp}.json`);
  
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
  
  console.log(`\n💾 Results saved to: ${resultsPath}`);
  console.log('='.repeat(70) + '\n');

  // Exit with error if any failed
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
