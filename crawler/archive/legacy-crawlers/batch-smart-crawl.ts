#!/usr/bin/env tsx
/**
 * Batch crawl all Carroll County towns with smart crawler
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

const towns = [
  { name: "Albany", url: "https://albanynh.org" },
  { name: "Bartlett", url: "https://www.townofbartlett.nh.gov" },
  { name: "Brookfield", url: "https://www.brookfieldnh.gov" },
  { name: "Chatham", url: "https://www.chathamnh.org" },
  { name: "Conway", url: "https://conwaynh.gov" },
  { name: "Eaton", url: "https://www.eatonnh.gov" },
  { name: "Effingham", url: "https://effinghamnh.net" },
  { name: "Freedom", url: "https://townoffreedomnh.gov" },
  { name: "Hart's Location", url: "https://hartslocation.com" },
  { name: "Jackson", url: "https://www.jackson-nh.gov" },
  { name: "Madison", url: "https://madison-nh.org" },
  { name: "Moultonborough", url: "https://moultonboroughnh.gov" },
  { name: "Ossipee", url: "https://www.ossipee.org" },
  { name: "Sandwich", url: "https://www.sandwichnh.com" },
  { name: "Tamworth", url: "https://tamworthnh.gov" },
  { name: "Tuftonboro", url: "https://www.tuftonboronh.gov" },
  { name: "Wakefield", url: "https://www.wakefieldnh.gov" },
  { name: "Wolfeboro", url: "https://www.wolfeboronh.us" }
];

const LOG_DIR = '/home/ubuntu/.openclaw/workspace/OPENCouncil/crawl-logs';
const RESULTS_FILE = path.join(LOG_DIR, 'batch-results.json');

interface TownResult {
  name: string;
  url: string;
  success: boolean;
  docsFound: number;
  strategiesUsed: string[];
  cms: string;
  workingPages: string[];
  categories: Record<string, number>;
  error?: string;
  logFile: string;
}

async function crawlTown(town: { name: string; url: string }, thorough: boolean): Promise<TownResult> {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Crawling ${town.name}...`);
    console.log(`${'='.repeat(60)}`);
    
    const logFile = path.join(LOG_DIR, `${town.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}.log`);
    
    const args = [
      'run', 'crawl:smart', '--',
      '--town', town.name,
      '--url', town.url,
      '--dry-run'
    ];
    
    if (thorough) {
      args.push('--thorough');
    }
    
    const proc = spawn('npm', args, {
      cwd: '/home/ubuntu/.openclaw/workspace/OPENCouncil',
      shell: false
    });
    
    let output = '';
    
    proc.stdout?.on('data', (data) => {
      const str = data.toString();
      output += str;
      process.stdout.write(str);
    });
    
    proc.stderr?.on('data', (data) => {
      const str = data.toString();
      output += str;
      process.stderr.write(str);
    });
    
    proc.on('close', async (code) => {
      // Save log
      await fs.mkdir(LOG_DIR, { recursive: true });
      await fs.writeFile(logFile, output);
      
      // Parse output
      const result: TownResult = {
        name: town.name,
        url: town.url,
        success: code === 0,
        docsFound: 0,
        strategiesUsed: [],
        cms: 'Unknown',
        workingPages: [],
        categories: {},
        logFile
      };
      
      if (code !== 0) {
        result.error = `Exit code ${code}`;
        resolve(result);
        return;
      }
      
      // Extract data from output
      const cmsMatch = output.match(/CMS: (\w+)/);
      if (cmsMatch) result.cms = cmsMatch[1];
      
      const docsMatch = output.match(/DISCOVERY COMPLETE: (\d+) documents/);
      if (docsMatch) result.docsFound = parseInt(docsMatch[1]);
      
      const strategiesMatch = output.match(/Strategies used: ([^\n]+)/);
      if (strategiesMatch) {
        result.strategiesUsed = strategiesMatch[1].split(' → ').map(s => s.trim());
      }
      
      // Extract working pages
      const workingPagesMatch = output.match(/📄 Working index pages:[\s\S]*?(?=\n\n|📊)/);
      if (workingPagesMatch) {
        const pages = workingPagesMatch[0].match(/\/[^\n]+/g);
        if (pages) result.workingPages = pages.map(p => p.trim());
      }
      
      // Extract categories
      const categoryMatches = output.matchAll(/[✓-] (\w+): (\d+)/g);
      for (const match of categoryMatches) {
        result.categories[match[1]] = parseInt(match[2]);
      }
      
      resolve(result);
    });
  });
}

async function main() {
  const thorough = process.argv.includes('--thorough');
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Carroll County Batch Crawl`);
  console.log(`Mode: ${thorough ? 'Thorough' : 'Adaptive'}`);
  console.log(`Towns: ${towns.length}`);
  console.log(`${'='.repeat(60)}\n`);
  
  const results: TownResult[] = [];
  
  for (const town of towns) {
    const result = await crawlTown(town, thorough);
    results.push(result);
    
    console.log(`\n✓ ${town.name}: ${result.docsFound} docs (${result.cms})`);
    
    // Brief pause between towns
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Save results
  await fs.writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
  
  // Summary
  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`BATCH COMPLETE`);
  console.log(`${'='.repeat(60)}\n`);
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const totalDocs = results.reduce((sum, r) => sum + r.docsFound, 0);
  
  console.log(`Successful: ${successful.length}/${towns.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Total documents: ${totalDocs}`);
  
  if (failed.length > 0) {
    console.log(`\nFailed towns:`);
    failed.forEach(r => console.log(`  - ${r.name}: ${r.error}`));
  }
  
  console.log(`\nResults saved to: ${RESULTS_FILE}`);
  console.log(`Logs saved to: ${LOG_DIR}/\n`);
}

main().catch(console.error);
