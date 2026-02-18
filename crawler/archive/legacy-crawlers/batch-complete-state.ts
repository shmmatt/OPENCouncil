#!/usr/bin/env tsx
/**
 * Complete State Tracking for Missing Towns
 * 
 * Runs V2 crawler on the 9 towns that don't have state records yet
 * These towns have docs in S3 but were crawled before state system was added
 */

import { spawn } from 'child_process';
import * as path from 'path';

interface Town {
  name: string;
  url: string;
}

// Towns that need state tracking (docs in S3, but 0 in state DB)
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
  
  return new Promise((resolve) => {
    const args = [
      '--env-file=.env',
      'scripts/universal-document-crawler-v2.ts',
      '--town', town.name,
      '--url', town.url,
      '--max-pages', '200'
    ];
    
    const proc = spawn('tsx', args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env }
    });
    
    // Timeout handler
    const timeout = setTimeout(() => {
      console.log(`\n⏰ Timeout: ${town.name} exceeded ${timeoutMinutes} minutes`);
      proc.kill('SIGTERM');
      
      resolve({
        name: town.name,
        url: town.url,
        success: false,
        docsFound: 0,
        uploaded: 0,
        error: `Timeout after ${timeoutMinutes} minutes`,
        duration: (Date.now() - startTime) / 1000 / 60
      });
    }, timeoutMinutes * 60 * 1000);
    
    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = (Date.now() - startTime) / 1000 / 60;
      
      if (code === 0) {
        console.log(`\n✅ ${town.name} completed successfully`);
        resolve({
          name: town.name,
          url: town.url,
          success: true,
          docsFound: 0, // Will be populated by state inspection
          uploaded: 0,
          duration
        });
      } else {
        console.log(`\n❌ ${town.name} failed with code ${code}`);
        resolve({
          name: town.name,
          url: town.url,
          success: false,
          docsFound: 0,
          uploaded: 0,
          error: `Exit code ${code}`,
          duration
        });
      }
    });
    
    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.log(`\n❌ ${town.name} error: ${err.message}`);
      resolve({
        name: town.name,
        url: town.url,
        success: false,
        docsFound: 0,
        uploaded: 0,
        error: err.message,
        duration: (Date.now() - startTime) / 1000 / 60
      });
    });
  });
}

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('📊 COMPLETE STATE TRACKING - 9 MISSING TOWNS');
  console.log('='.repeat(70));
  console.log(`🏛️  Towns: ${MISSING_STATE_TOWNS.length}`);
  console.log(`📄 Target: Populate state database for existing S3 docs`);
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
    console.log(`\n📊 Progress: ${i + 1}/${MISSING_STATE_TOWNS.length} complete`);
    console.log(`   ✅ Success: ${successCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
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
  
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(console.error);
