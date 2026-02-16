#!/usr/bin/env tsx
/**
 * Complete State Tracking - PARALLEL VERSION
 * 
 * Runs multiple towns concurrently for faster completion
 */

import { spawn } from 'child_process';
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

interface TownResult {
  name: string;
  url: string;
  success: boolean;
  docsFound: number;
  uploaded: number;
  error?: string;
  duration: number;
}

async function crawlTown(town: Town, concurrentNum: number): Promise<TownResult> {
  const startTime = Date.now();
  
  console.log(`\n[$${concurrentNum}] 🏛️  Starting: ${town.name} (${town.url})`);
  
  return new Promise((resolve) => {
    const child = spawn(
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
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let output = '';
    let errorOutput = '';

    child.stdout?.on('data', (data) => {
      const str = data.toString();
      output += str;
      // Prefix output with town identifier
      process.stdout.write(`[${town.name}] ${str}`);
    });

    child.stderr?.on('data', (data) => {
      const str = data.toString();
      errorOutput += str;
      process.stderr.write(`[${town.name}] ${str}`);
    });

    // 30 minute timeout per town
    const timeout = setTimeout(() => {
      console.log(`\n[$${concurrentNum}] ⏱️  ${town.name} timed out after 30min`);
      child.kill('SIGTERM');
    }, 30 * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = (Date.now() - startTime) / 1000 / 60;
      
      // Parse output for stats
      const docsMatch = output.match(/📥 Documents discovered: (\d+)/);
      const uploadMatch = output.match(/✅ Uploaded: (\d+)/);
      
      const docsFound = docsMatch ? parseInt(docsMatch[1]) : 0;
      const uploaded = uploadMatch ? parseInt(uploadMatch[1]) : 0;

      if (code === 0) {
        console.log(`\n[$${concurrentNum}] ✅ ${town.name} completed in ${duration.toFixed(1)}min (${docsFound} docs, ${uploaded} uploaded)`);
        resolve({
          name: town.name,
          url: town.url,
          success: true,
          docsFound,
          uploaded,
          duration
        });
      } else {
        console.log(`\n[$${concurrentNum}] ❌ ${town.name} failed with code ${code}`);
        resolve({
          name: town.name,
          url: town.url,
          success: false,
          docsFound,
          uploaded,
          error: `Exit code ${code}`,
          duration
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      const duration = (Date.now() - startTime) / 1000 / 60;
      console.log(`\n[$${concurrentNum}] ❌ ${town.name} error: ${err.message}`);
      resolve({
        name: town.name,
        url: town.url,
        success: false,
        docsFound: 0,
        uploaded: 0,
        error: err.message,
        duration
      });
    });
  });
}

async function main() {
  const startTime = Date.now();
  
  // Parse concurrency from command line (default 4)
  const concurrency = parseInt(process.argv[2]) || 4;
  
  console.log('='.repeat(70));
  console.log('📊 COMPLETE STATE TRACKING - PARALLEL VERSION');
  console.log('='.repeat(70));
  console.log(`🏛️  Towns: ${MISSING_STATE_TOWNS.length}`);
  console.log(`🚀 Concurrency: ${concurrency} towns at once`);
  console.log(`⏰ Started: ${new Date().toISOString()}`);
  console.log('='.repeat(70));

  const results: TownResult[] = [];
  
  // Process towns in batches
  for (let i = 0; i < MISSING_STATE_TOWNS.length; i += concurrency) {
    const batch = MISSING_STATE_TOWNS.slice(i, i + concurrency);
    console.log(`\n🔄 Starting batch ${Math.floor(i / concurrency) + 1} (${batch.map(t => t.name).join(', ')})\n`);
    
    const batchResults = await Promise.all(
      batch.map((town, idx) => crawlTown(town, i + idx + 1))
    );
    
    results.push(...batchResults);
  }

  const totalDuration = (Date.now() - startTime) / 1000 / 60;
  
  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 BATCH COMPLETE');
  console.log('='.repeat(70));
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalDocs = results.reduce((sum, r) => sum + r.docsFound, 0);
  const totalUploaded = results.reduce((sum, r) => sum + r.uploaded, 0);
  
  console.log(`✅ Success: ${successful}/${MISSING_STATE_TOWNS.length}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📄 Total docs discovered: ${totalDocs}`);
  console.log(`☁️  Total uploaded: ${totalUploaded}`);
  console.log(`⏱️  Total time: ${totalDuration.toFixed(1)} minutes`);
  
  console.log('\n📋 Individual Results:');
  results.forEach(r => {
    const status = r.success ? '✅' : '❌';
    const error = r.error ? ` (${r.error})` : '';
    console.log(`  ${status} ${r.name}: ${r.docsFound} docs, ${r.uploaded} uploaded, ${r.duration.toFixed(1)}min${error}`);
  });

  // Save results
  const logDir = path.join(process.cwd(), 'crawl-logs');
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `state-completion-parallel-${new Date().toISOString().split('T')[0]}.json`);
  
  await fs.writeFile(logFile, JSON.stringify({
    results,
    summary: {
      success: successful,
      failed,
      totalDocs,
      totalUploaded,
      totalMinutes: totalDuration,
      concurrency
    }
  }, null, 2));
  
  console.log(`\n💾 Results saved: ${logFile}`);
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
