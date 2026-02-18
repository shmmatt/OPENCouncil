#!/usr/bin/env tsx
/**
 * Complete State Tracking - FIXED VERSION
 * 
 * Runs V2 crawler sequentially (not nohup) to avoid stdio issues
 * Uses proper process management and error handling
 */

import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

interface Town {
  name: string;
  url: string;
}

// Towns that need state tracking
const MISSING_STATE_TOWNS: Town[] = [
  { name: 'Madison', url: 'https://madison-nh.org' },
  { name: 'Moultonborough', url: 'https://moultonboroughnh.gov' },
  { name: 'Ossipee', url: 'https://www.ossipee.org' },
  { name: 'Sandwich', url: 'https://www.sandwichnh.com' },
  { name: 'Tamworth', url: 'https://tamworthnh.gov' },
  { name: 'Tuftonboro', url: 'https://www.tuftonboronh.gov' },
  { name: 'Wakefield', url: 'https://www.wakefieldnh.gov' },
  { name: 'Wolfeboro', url: 'https://www.wolfeboronh.us' },
];

// WordPress towns need longer timeout
const WORDPRESS_TOWNS = ['Madison', 'Sandwich', 'Tamworth'];

interface TownResult {
  name: string;
  url: string;
  success: boolean;
  docsFound: number;
  uploaded: number;
  error?: string;
  duration: number;
}

async function crawlTown(town: Town): Promise<TownResult> {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🏛️  Crawling: ${town.name}`);
  console.log(`🌐 URL: ${town.url}`);
  console.log(`⏰ Started: ${new Date().toISOString()}`);
  
  const isWordPress = WORDPRESS_TOWNS.includes(town.name);
  const timeoutMinutes = isWordPress ? 30 : 20;
  const timeoutMs = timeoutMinutes * 60 * 1000;
  
  // Use spawnSync instead of spawn - runs in foreground, no stdio issues
  const result = spawnSync(
    'tsx',
    [
      '--env-file=.env',
      'scripts/universal-document-crawler-v2.ts',
      '--town', town.name,
      '--url', town.url,
      '--max-pages', '200'
    ],
    {
      cwd: process.cwd(),
      stdio: 'inherit', // Inherit stdio from parent process
      env: { ...process.env },
      timeout: timeoutMs,
      killSignal: 'SIGTERM'
    }
  );
  
  const duration = (Date.now() - startTime) / 1000 / 60;
  
  if (result.error) {
    console.log(`\n❌ ${town.name} error: ${result.error.message}`);
    return {
      name: town.name,
      url: town.url,
      success: false,
      docsFound: 0,
      uploaded: 0,
      error: result.error.message,
      duration
    };
  }
  
  if (result.signal) {
    console.log(`\n⏰ ${town.name} timeout after ${timeoutMinutes} minutes`);
    return {
      name: town.name,
      url: town.url,
      success: false,
      docsFound: 0,
      uploaded: 0,
      error: `Timeout (${timeoutMinutes}min)`,
      duration
    };
  }
  
  if (result.status === 0) {
    console.log(`\n✅ ${town.name} completed successfully`);
    return {
      name: town.name,
      url: town.url,
      success: true,
      docsFound: 0, // Will be in DB
      uploaded: 0,
      duration
    };
  } else {
    console.log(`\n❌ ${town.name} failed with code ${result.status}`);
    return {
      name: town.name,
      url: town.url,
      success: false,
      docsFound: 0,
      uploaded: 0,
      error: `Exit code ${result.status}`,
      duration
    };
  }
}

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('📊 COMPLETE STATE TRACKING - FIXED VERSION');
  console.log('='.repeat(70));
  console.log(`🏛️  Towns: ${MISSING_STATE_TOWNS.length}`);
  console.log(`📄 Strategy: Sequential execution (no nohup, no stdio issues)`);
  console.log(`⚡ Expected: Fast (most docs already in S3, smart skipping)`);
  console.log(`⏰ Started: ${new Date().toISOString()}`);
  console.log('='.repeat(70) + '\n');
  
  const results: TownResult[] = [];
  let successCount = 0;
  let failCount = 0;
  const batchStart = Date.now();
  
  for (let i = 0; i < MISSING_STATE_TOWNS.length; i++) {
    const town = MISSING_STATE_TOWNS[i];
    console.log(`\n[${i + 1}/${MISSING_STATE_TOWNS.length}] Processing ${town.name}...`);
    
    const result = await crawlTown(town);
    results.push(result);
    
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
    
    // Progress summary
    const elapsed = (Date.now() - batchStart) / 1000 / 60;
    console.log(`\n📊 Progress: ${i + 1}/${MISSING_STATE_TOWNS.length} complete`);
    console.log(`   ✅ Success: ${successCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
    console.log(`   ⏱️  Elapsed: ${elapsed.toFixed(1)} minutes`);
    
    // Small delay between towns to avoid resource conflicts
    if (i < MISSING_STATE_TOWNS.length - 1) {
      console.log(`   ⏸️  Waiting 5 seconds before next town...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  // Final summary
  const totalMinutes = (Date.now() - batchStart) / 1000 / 60;
  
  console.log('\n' + '='.repeat(70));
  console.log('📊 FINAL RESULTS');
  console.log('='.repeat(70));
  console.log(`✅ Success: ${successCount}/${MISSING_STATE_TOWNS.length}`);
  console.log(`❌ Failed: ${failCount}/${MISSING_STATE_TOWNS.length}`);
  console.log(`⏱️  Total Time: ${totalMinutes.toFixed(1)} minutes`);
  console.log(`⏰ Completed: ${new Date().toISOString()}`);
  console.log('='.repeat(70) + '\n');
  
  // Individual results
  console.log('📋 Individual Results:\n');
  results.forEach((r, i) => {
    const status = r.success ? '✅' : '❌';
    const errorMsg = r.error ? ` (${r.error})` : '';
    console.log(`${i + 1}. ${status} ${r.name} - ${r.duration.toFixed(1)} min${errorMsg}`);
  });
  
  console.log('\n✨ Next step: Run state inspection to verify:');
  console.log('   npm run state:inspect -- --all\n');
  
  // Save results to file
  const resultsFile = path.join(process.cwd(), 'crawl-logs', `state-completion-${new Date().toISOString().split('T')[0]}.json`);
  await fs.mkdir(path.dirname(resultsFile), { recursive: true });
  await fs.writeFile(resultsFile, JSON.stringify({ results, summary: { success: successCount, failed: failCount, totalMinutes } }, null, 2));
  console.log(`💾 Results saved to: ${resultsFile}\n`);
  
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(console.error);
