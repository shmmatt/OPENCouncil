#!/usr/bin/env tsx
/**
 * Resume batch crawl from a specific town
 */

import { spawn } from 'child_process';

interface Town {
  name: string;
  url: string;
}

const ALL_TOWNS: Town[] = [
  { name: 'Albany', url: 'https://albanynh.org' },
  { name: 'Bartlett', url: 'https://www.townofbartlett.nh.gov' },
  { name: 'Brookfield', url: 'https://www.brookfieldnh.gov' },
  { name: 'Chatham', url: 'https://www.chathamnh.org' },
  { name: 'Conway', url: 'https://conwaynh.gov' },
  { name: 'Eaton', url: 'https://www.eatonnh.gov' },
  { name: 'Effingham', url: 'https://effinghamnh.net' },
  { name: 'Freedom', url: 'https://townoffreedomnh.gov' },
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

const startFrom = process.argv[2];

if (!startFrom) {
  console.error('Usage: tsx resume-batch-from-town.ts <town-name>');
  console.error('Example: tsx resume-batch-from-town.ts Chatham');
  process.exit(1);
}

const startIndex = ALL_TOWNS.findIndex(t => t.name.toLowerCase() === startFrom.toLowerCase());

if (startIndex === -1) {
  console.error(`Town not found: ${startFrom}`);
  process.exit(1);
}

const remainingTowns = ALL_TOWNS.slice(startIndex);

console.log(`\n🔄 Resuming batch crawl from: ${startFrom}`);
console.log(`📊 Remaining towns: ${remainingTowns.length}\n`);

async function crawlTown(town: Town): Promise<boolean> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🏛️  Crawling: ${town.name}`);
  console.log(`${'='.repeat(70)}\n`);

  return new Promise((resolve) => {
    const proc = spawn('npm', [
      'run',
      'crawl:universal:v2',
      '--',
      '--town',
      town.name,
      '--url',
      town.url,
      '--max-pages',
      '200',
    ], {
      stdio: 'inherit',
      shell: true,
    });

    const timeout = setTimeout(() => {
      console.log(`\n⏰ Timeout: ${town.name} exceeded 30 minutes`);
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, 30 * 60 * 1000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const success = code === 0;
      console.log(`\n${success ? '✅' : '❌'} ${town.name} ${success ? 'completed' : 'failed'}\n`);
      
      // Wait 5 seconds between towns
      setTimeout(() => resolve(success), 5000);
    });
  });
}

async function main() {
  const startTime = Date.now();
  let completed = 0;
  let failed = 0;

  for (const town of remainingTowns) {
    const success = await crawlTown(town);
    if (success) {
      completed++;
    } else {
      failed++;
    }
    
    console.log(`\n📊 Progress: ${completed + failed}/${remainingTowns.length} (${completed} ✅, ${failed} ❌)\n`);
  }

  const elapsed = (Date.now() - startTime) / 1000 / 60;
  
  console.log('\n' + '='.repeat(70));
  console.log('🎉 BATCH COMPLETE');
  console.log('='.repeat(70));
  console.log(`✅ Completed: ${completed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`⏱️  Time: ${elapsed.toFixed(1)} minutes`);
  console.log('='.repeat(70) + '\n');
}

main().catch(console.error);
