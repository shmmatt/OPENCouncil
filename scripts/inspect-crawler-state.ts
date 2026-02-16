#!/usr/bin/env tsx
/**
 * Inspect Crawler State
 * 
 * Quick utility to view crawler state for a town or all towns
 */

import {
  getTownState,
  getAllTowns,
  getTownRuns,
  getTownDocuments,
} from '../server/services/crawlerState';

async function inspectTown(slug: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🏛️  Town State: ${slug}`);
  console.log(`${'='.repeat(70)}\n`);
  
  const state = await getTownState(slug);
  
  if (!state) {
    console.log(`❌ Town "${slug}" not found in database\n`);
    return;
  }
  
  const { town, latestSitemap, latestRun, documentStats } = state;
  
  // Town info
  console.log(`📋 Town Information:`);
  console.log(`   Name: ${town.name}`);
  console.log(`   URL: ${town.url}`);
  console.log(`   CMS: ${town.cms || 'Unknown'}`);
  console.log(`   Status: ${town.status}`);
  console.log(`   County: ${town.county}, ${town.state}`);
  console.log(``);
  
  // Crawl history
  console.log(`📅 Crawl History:`);
  console.log(`   Last Full Crawl: ${town.lastFullCrawl ? new Date(town.lastFullCrawl).toLocaleString() : 'Never'}`);
  console.log(`   Last Incremental: ${town.lastIncrementalCrawl ? new Date(town.lastIncrementalCrawl).toLocaleString() : 'Never'}`);
  console.log(`   Consecutive Failures: ${town.consecutiveFailures}`);
  console.log(``);
  
  // Stats
  console.log(`📊 Document Stats:`);
  console.log(`   Total Documents: ${town.totalDocuments}`);
  console.log(`   Total Uploaded: ${town.totalUploaded}`);
  console.log(`   Last Crawl Found: ${town.lastCrawlDocsFound} docs`);
  console.log(``);
  
  // Current state
  console.log(`💾 Current State:`);
  console.log(`   Discovered: ${documentStats.discovered}`);
  console.log(`   Downloaded: ${documentStats.downloaded}`);
  console.log(`   Uploaded: ${documentStats.uploaded}`);
  console.log(`   Failed: ${documentStats.failed}`);
  console.log(``);
  
  // Sitemap
  if (latestSitemap) {
    console.log(`🗺️  Latest Sitemap:`);
    console.log(`   URL Count: ${latestSitemap.urlCount}`);
    console.log(`   Hash: ${latestSitemap.hash.substring(0, 16)}...`);
    console.log(`   Last Checked: ${new Date(latestSitemap.lastChecked).toLocaleString()}`);
    console.log(``);
  }
  
  // Latest run
  if (latestRun) {
    console.log(`🏃 Latest Run:`);
    console.log(`   Mode: ${latestRun.mode}`);
    console.log(`   Status: ${latestRun.status}`);
    console.log(`   Started: ${new Date(latestRun.startedAt).toLocaleString()}`);
    if (latestRun.completedAt) {
      const duration = (new Date(latestRun.completedAt).getTime() - new Date(latestRun.startedAt).getTime()) / 1000 / 60;
      console.log(`   Completed: ${new Date(latestRun.completedAt).toLocaleString()} (${duration.toFixed(1)} min)`);
    }
    console.log(`   Pages Visited: ${latestRun.pagesVisited}`);
    console.log(`   Docs Discovered: ${latestRun.documentsDiscovered}`);
    console.log(`   Docs Downloaded: ${latestRun.documentsDownloaded}`);
    console.log(`   Docs Uploaded: ${latestRun.documentsUploaded}`);
    if (latestRun.errorMessage) {
      console.log(`   Error: ${latestRun.errorMessage}`);
    }
    console.log(``);
  }
  
  // Recent runs
  const runs = await getTownRuns(state.town.id, 5);
  if (runs.length > 1) {
    console.log(`📜 Recent Runs (last 5):`);
    runs.forEach((run, i) => {
      const status = run.status === 'completed' ? '✅' : run.status === 'failed' ? '❌' : '⏳';
      console.log(`   ${i + 1}. ${status} ${run.mode} - ${new Date(run.startedAt).toLocaleString()} (${run.documentsUploaded} docs)`);
    });
    console.log(``);
  }
}

async function listAllTowns() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🏛️  All Towns in Crawler State`);
  console.log(`${'='.repeat(70)}\n`);
  
  const towns = await getAllTowns();
  
  console.log(`Total: ${towns.length} towns\n`);
  
  for (const town of towns) {
    const statusEmoji = town.status === 'active' ? '✅' : town.status === 'paused' ? '⏸️' : '❌';
    const lastCrawl = town.lastFullCrawl 
      ? new Date(town.lastFullCrawl).toLocaleDateString() 
      : 'Never';
    
    console.log(`${statusEmoji} ${town.name.padEnd(20)} | Docs: ${String(town.totalDocuments).padStart(4)} | Uploaded: ${String(town.totalUploaded).padStart(4)} | Last: ${lastCrawl}`);
  }
  
  console.log(``);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help') {
    console.log(`
Usage:
  npm run state:inspect                  List all towns
  npm run state:inspect <town-slug>      Inspect specific town
  
Examples:
  npm run state:inspect
  npm run state:inspect conway
  npm run state:inspect ossipee
    `);
    return;
  }
  
  if (args[0] === '--all' || args.length === 0) {
    await listAllTowns();
  } else {
    const slug = args[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
    await inspectTown(slug);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
