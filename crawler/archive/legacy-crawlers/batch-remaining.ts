#!/usr/bin/env tsx
/**
 * Run remaining 6 towns
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
  error?: string;
}

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

    child.stdout?.on('data', (data) => {
      const str = data.toString();
      output += str;
      
      const progressMatch = str.match(/Progress: (\d+)\/(\d+) pages \| (\d+) docs/);
      if (progressMatch) {
        console.log(`[${town.name}] 📊 ${progressMatch[1]}/${progressMatch[2]} pages, ${progressMatch[3]} docs`);
      }
      
      if (str.includes('Documents found:')) {
        const docsMatch = str.match(/Documents found: (\d+)/);
        if (docsMatch) {
          console.log(`[${town.name}] ✅ Found ${docsMatch[1]} documents`);
        }
      }
    });

    child.stderr?.on('data', (data) => {
      const str = data.toString();
      if (str.includes('Error') || str.includes('ERROR')) {
        console.log(`[${town.name}] ⚠️  ${str.trim()}`);
      }
    });

    const timeout = setTimeout(() => {
      console.log(`[${town.name}] ⏱️  Timeout after 30min`);
      child.kill('SIGTERM');
    }, 30 * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = (Date.now() - startTime) / 1000 / 60;
      
      if (code === 0) {
        const docsMatch = output.match(/Documents found: (\d+)/);
        const pagesMatch = output.match(/Pages visited: (\d+)/);
        
        const documentsFound = docsMatch ? parseInt(docsMatch[1]) : 0;
        const pagesVisited = pagesMatch ? parseInt(pagesMatch[1]) : 0;
        
        console.log(`[${town.name}] ✅ Complete in ${duration.toFixed(1)}min`);
        
        resolve({
          name: town.name,
          url: town.url,
          success: true,
          documentsFound,
          pagesVisited,
          duration
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
  
  const townsFile = path.join(process.cwd(), 'scripts/remaining-towns.json');
  const towns: Town[] = JSON.parse(await fs.readFile(townsFile, 'utf-8'));
  
  const concurrency = 3; // Run 3 at a time
  const maxPages = 200;
  
  console.log('='.repeat(70));
  console.log('📊 REMAINING 6 CARROLL COUNTY TOWNS');
  console.log('='.repeat(70));
  console.log(`🏛️  Towns: ${towns.map(t => t.name).join(', ')}`);
  console.log(`🚀 Concurrency: ${concurrency}`);
  console.log(`📄 Max pages: ${maxPages}`);
  console.log('='.repeat(70) + '\n');

  const results: TownResult[] = [];
  
  for (let i = 0; i < towns.length; i += concurrency) {
    const batch = towns.slice(i, i + concurrency);
    
    console.log(`\n🔄 Batch: ${batch.map(t => t.name).join(', ')}\n`);
    
    const batchResults = await Promise.all(
      batch.map((town) => crawlTown(town, maxPages))
    );
    
    results.push(...batchResults);
  }

  const totalDuration = (Date.now() - startTime) / 1000 / 60;
  
  console.log('\n' + '='.repeat(70));
  console.log('📊 RESULTS');
  console.log('='.repeat(70));
  
  const successful = results.filter(r => r.success).length;
  const totalDocs = results.reduce((sum, r) => sum + r.documentsFound, 0);
  
  results.forEach(r => {
    const status = r.success ? '✅' : '❌';
    console.log(`${status} ${r.name}: ${r.documentsFound} docs, ${r.pagesVisited} pages, ${r.duration.toFixed(1)}min`);
  });
  
  console.log(`\n✅ Success: ${successful}/${towns.length}`);
  console.log(`📄 Total: ${totalDocs} documents`);
  console.log(`⏱️  Total time: ${totalDuration.toFixed(1)} minutes`);
  
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
