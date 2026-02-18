#!/usr/bin/env tsx
/**
 * Batch V3 Crawler - Parallel Execution
 * 
 * Runs V3 crawler on multiple towns concurrently
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

interface Town {
  name: string;
  url: string;
}

interface TownResult {
  name: string;
  url: string;
  success: boolean;
  documentsFound: number;
  pagesVisited: number;
  duration: number;
  coverage?: number;
  error?: string;
}

const S3_BASELINES: Record<string, number> = {
  'Moultonborough': 263,
  'Madison': 1398,
  'Ossipee': 655,
  'Wolfeboro': 291,
};

async function crawlTown(town: Town, maxPages: number = 200): Promise<TownResult> {
  const startTime = Date.now();
  
  console.log(`[${town.name}] 🏛️  Starting...`);
  
  return new Promise((resolve) => {
    const child = spawn(
      'tsx',
      [
        'scripts/crawler-v3.ts',
        town.name,
        town.url,
        maxPages.toString()
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let output = '';
    let lastProgress = '';

    child.stdout?.on('data', (data) => {
      const str = data.toString();
      output += str;
      
      // Extract and show progress updates
      const progressMatch = str.match(/Progress: (\d+)\/(\d+) pages \| (\d+) docs/);
      if (progressMatch) {
        lastProgress = `${progressMatch[1]}/${progressMatch[2]} pages, ${progressMatch[3]} docs`;
        console.log(`[${town.name}] 📊 ${lastProgress}`);
      }
      
      // Show final results
      if (str.includes('Documents found:')) {
        const docsMatch = str.match(/Documents found: (\d+)/);
        if (docsMatch) {
          console.log(`[${town.name}] ✅ Found ${docsMatch[1]} documents`);
        }
      }
    });

    child.stderr?.on('data', (data) => {
      const str = data.toString();
      // Only log actual errors, not debug output
      if (str.includes('Error') || str.includes('ERROR')) {
        console.log(`[${town.name}] ⚠️  ${str.trim()}`);
      }
    });

    // 30 minute timeout per town
    const timeout = setTimeout(() => {
      console.log(`[${town.name}] ⏱️  Timeout after 30min`);
      child.kill('SIGTERM');
    }, 30 * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = (Date.now() - startTime) / 1000 / 60;
      
      if (code === 0) {
        // Parse results from output
        const docsMatch = output.match(/Documents found: (\d+)/);
        const pagesMatch = output.match(/Pages visited: (\d+)/);
        const coverageMatch = output.match(/Coverage: ([\d.]+)%/);
        
        const documentsFound = docsMatch ? parseInt(docsMatch[1]) : 0;
        const pagesVisited = pagesMatch ? parseInt(pagesMatch[1]) : 0;
        const coverage = coverageMatch ? parseFloat(coverageMatch[1]) : undefined;
        
        console.log(`[${town.name}] ✅ Complete in ${duration.toFixed(1)}min`);
        
        resolve({
          name: town.name,
          url: town.url,
          success: true,
          documentsFound,
          pagesVisited,
          duration,
          coverage
        });
      } else {
        console.log(`[${town.name}] ❌ Failed with code ${code}`);
        resolve({
          name: town.name,
          url: town.url,
          success: false,
          documentsFound: 0,
          pagesVisited: 0,
          duration,
          error: `Exit code ${code}`
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      const duration = (Date.now() - startTime) / 1000 / 60;
      console.log(`[${town.name}] ❌ Error: ${err.message}`);
      resolve({
        name: town.name,
        url: town.url,
        success: false,
        documentsFound: 0,
        pagesVisited: 0,
        duration,
        error: err.message
      });
    });
  });
}

async function main() {
  const startTime = Date.now();
  
  // Load towns
  const townsFile = path.join(process.cwd(), 'scripts/carroll-county-towns.json');
  const towns: Town[] = JSON.parse(await fs.readFile(townsFile, 'utf-8'));
  
  // Parse arguments
  const concurrency = parseInt(process.argv[2]) || 4;
  const maxPages = parseInt(process.argv[3]) || 200;
  
  console.log('='.repeat(70));
  console.log('📊 BATCH V3 CRAWLER - PARALLEL EXECUTION');
  console.log('='.repeat(70));
  console.log(`🏛️  Towns: ${towns.length} (Carroll County)`);
  console.log(`🚀 Concurrency: ${concurrency} towns at once`);
  console.log(`📄 Max pages per town: ${maxPages}`);
  console.log(`⏰ Started: ${new Date().toISOString()}`);
  console.log('='.repeat(70) + '\n');

  const results: TownResult[] = [];
  
  // Process towns in batches
  for (let i = 0; i < towns.length; i += concurrency) {
    const batch = towns.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(towns.length / concurrency);
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🔄 BATCH ${batchNum}/${totalBatches}: ${batch.map(t => t.name).join(', ')}`);
    console.log('='.repeat(70) + '\n');
    
    const batchResults = await Promise.all(
      batch.map((town) => crawlTown(town, maxPages))
    );
    
    results.push(...batchResults);
    
    // Show batch summary
    const batchSuccess = batchResults.filter(r => r.success).length;
    const batchDocs = batchResults.reduce((sum, r) => sum + r.documentsFound, 0);
    console.log(`\n✅ Batch ${batchNum} complete: ${batchSuccess}/${batch.length} succeeded, ${batchDocs} total docs\n`);
  }

  const totalDuration = (Date.now() - startTime) / 1000 / 60;
  
  // Final Summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 FINAL RESULTS');
  console.log('='.repeat(70));
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalDocs = results.reduce((sum, r) => sum + r.documentsFound, 0);
  const totalPages = results.reduce((sum, r) => sum + r.pagesVisited, 0);
  
  console.log(`✅ Success: ${successful}/${towns.length}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📄 Total documents: ${totalDocs}`);
  console.log(`📄 Total pages visited: ${totalPages}`);
  console.log(`⏱️  Total time: ${totalDuration.toFixed(1)} minutes`);
  console.log(`⚡ Avg time per town: ${(totalDuration / towns.length).toFixed(1)} minutes`);
  
  // Detailed results table
  console.log('\n' + '='.repeat(70));
  console.log('📋 DETAILED RESULTS');
  console.log('='.repeat(70));
  console.log('Town                 | Docs  | Pages | Time(m) | Coverage');
  console.log('-'.repeat(70));
  
  results
    .sort((a, b) => b.documentsFound - a.documentsFound)
    .forEach(r => {
      const status = r.success ? '✅' : '❌';
      const name = r.name.padEnd(18);
      const docs = r.documentsFound.toString().padStart(5);
      const pages = r.pagesVisited.toString().padStart(5);
      const time = r.duration.toFixed(1).padStart(7);
      
      let coverage = '';
      if (r.success && S3_BASELINES[r.name]) {
        const pct = (r.documentsFound / S3_BASELINES[r.name] * 100).toFixed(0);
        coverage = `${pct}%`.padStart(8);
      }
      
      console.log(`${status} ${name} | ${docs} | ${pages} | ${time} |${coverage}`);
      
      if (r.error) {
        console.log(`   Error: ${r.error}`);
      }
    });
  
  // Save results
  const logDir = path.join(process.cwd(), 'crawl-logs');
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `batch-v3-${new Date().toISOString().split('T')[0]}.json`);
  
  await fs.writeFile(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    concurrency,
    maxPages,
    totalDuration,
    results,
    summary: {
      total: towns.length,
      success: successful,
      failed,
      totalDocuments: totalDocs,
      totalPages,
      avgTimePerTown: totalDuration / towns.length
    }
  }, null, 2));
  
  console.log(`\n💾 Results saved: ${logFile}`);
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
