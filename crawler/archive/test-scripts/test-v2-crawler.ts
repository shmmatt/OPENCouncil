#!/usr/bin/env tsx
/**
 * Test V2 Crawler on Problematic Towns
 * 
 * Tests the new crawler on towns that previously returned 0 documents:
 * - Ossipee (Cloudflare)
 * - Madison (WordPress, 0 nav links)
 * - Tuftonboro (Cloudflare)
 * - Wakefield (Cloudflare)
 * - Sandwich (homepage timeout)
 */

import { spawn } from 'child_process';

interface Town {
  name: string;
  url: string;
  issue: string;
}

const PROBLEM_TOWNS: Town[] = [
  {
    name: 'Madison',
    url: 'https://madison-nh.org',
    issue: 'WordPress with 0 nav links extracted'
  },
  {
    name: 'Ossipee',
    url: 'https://www.ossipee.org',
    issue: 'Cloudflare blocking'
  },
  {
    name: 'Tuftonboro',
    url: 'https://www.tuftonboronh.gov',
    issue: 'Cloudflare blocking'
  },
  {
    name: 'Wakefield',
    url: 'https://www.wakefieldonwakefieldnh.org',
    issue: 'Cloudflare blocking'
  },
  {
    name: 'Sandwich',
    url: 'https://www.sandwich.nh.us',
    issue: 'Homepage timeout'
  }
];

async function testTown(town: Town): Promise<{ name: string; success: boolean; docs: number; error?: string }> {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Testing: ${town.name}`);
    console.log(`Issue: ${town.issue}`);
    console.log(`URL: ${town.url}`);
    console.log(`${'='.repeat(70)}\n`);
    
    const proc = spawn('npm', ['run', 'crawl:universal:v2', '--', '--town', town.name, '--url', town.url, '--dry-run'], {
      stdio: 'inherit',
      shell: true
    });
    
    let output = '';
    
    proc.on('close', (code) => {
      // Parse output for doc count
      const match = output.match(/DISCOVERY COMPLETE: (\d+) documents/);
      const docs = match ? parseInt(match[1]) : 0;
      
      resolve({
        name: town.name,
        success: code === 0 && docs > 0,
        docs,
        error: code !== 0 ? `Exit code ${code}` : undefined
      });
    });
    
    proc.on('error', (err) => {
      resolve({
        name: town.name,
        success: false,
        docs: 0,
        error: err.message
      });
    });
  });
}

async function main() {
  console.log('🧪 Testing Universal Document Crawler V2');
  console.log(`Testing ${PROBLEM_TOWNS.length} previously failed towns\n`);
  
  const results: Array<{ name: string; success: boolean; docs: number; error?: string }> = [];
  
  for (const town of PROBLEM_TOWNS) {
    const result = await testTown(town);
    results.push(result);
    
    // Wait between towns
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  // Summary
  console.log('\n\n' + '='.repeat(70));
  console.log('TEST RESULTS SUMMARY');
  console.log('='.repeat(70) + '\n');
  
  const successful = results.filter(r => r.success).length;
  
  results.forEach(result => {
    const status = result.success ? '✅' : '❌';
    const docs = result.docs > 0 ? ` (${result.docs} docs)` : '';
    const error = result.error ? ` - ${result.error}` : '';
    
    console.log(`${status} ${result.name}${docs}${error}`);
  });
  
  console.log(`\nSuccess rate: ${successful}/${results.length} (${Math.round(successful / results.length * 100)}%)`);
  
  const totalDocs = results.reduce((sum, r) => sum + r.docs, 0);
  console.log(`Total documents discovered: ${totalDocs}`);
  
  if (successful === results.length) {
    console.log('\n🎉 All tests passed! V2 crawler is working correctly.');
  } else {
    console.log('\n⚠️  Some towns still failing. Review logs above for details.');
  }
}

main().catch(console.error);
