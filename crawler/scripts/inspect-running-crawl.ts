#!/usr/bin/env tsx
/**
 * Quick inspection of what URLs are being crawled right now
 */

import { db } from '../server/storage/db';
import { crawlerRuns, crawlerUrls, crawlerTowns } from '../shared/crawler-schema';
import { eq, desc, and } from 'drizzle-orm';

async function inspect() {
  // Find currently running crawls
  const runningRuns = await db.select({
    run: crawlerRuns,
    town: crawlerTowns
  })
  .from(crawlerRuns)
  .innerJoin(crawlerTowns, eq(crawlerRuns.townId, crawlerTowns.id))
  .where(eq(crawlerRuns.status, 'running'))
  .orderBy(desc(crawlerRuns.startedAt));
  
  if (runningRuns.length === 0) {
    console.log('No currently running crawls');
    return;
  }
  
  for (const { run, town } of runningRuns) {
    console.log('\n' + '='.repeat(70));
    console.log(`🏛️  ${town.name} (${town.cms})`);
    console.log(`📊 Pages visited: ${run.pagesVisited || 0}`);
    console.log(`📄 Docs discovered: ${run.docsDiscovered || 0}`);
    console.log('='.repeat(70));
    
    // Get last 30 URLs visited
    const recentUrls = await db.select()
      .from(crawlerUrls)
      .where(eq(crawlerUrls.townId, town.id))
      .orderBy(desc(crawlerUrls.lastVisited))
      .limit(30);
    
    console.log(`\n📋 Last 30 URLs visited:\n`);
    
    recentUrls.forEach((u, i) => {
      const status = u.documentCount && u.documentCount > 0 ? `✅ ${u.documentCount} docs` : '❌ 0 docs';
      console.log(`${i+1}. ${status}`);
      console.log(`   ${u.url}`);
      console.log(`   Source: ${u.source}, Priority: ${u.priority}`);
    });
    
    // Analysis
    const withDocs = recentUrls.filter(u => u.documentCount && u.documentCount > 0);
    const successful = recentUrls.filter(u => u.status === 'visited');
    
    console.log(`\n📊 Analysis:`);
    console.log(`   Total recent URLs: ${recentUrls.length}`);
    console.log(`   Successfully visited: ${successful.length}`);
    console.log(`   Found documents: ${withDocs.length} URLs`);
    console.log(`   Success rate: ${((withDocs.length / recentUrls.length) * 100).toFixed(1)}%`);
    
    if (withDocs.length > 0) {
      console.log(`\n✅ URLs that found documents:`);
      withDocs.forEach(u => {
        console.log(`   ${u.documentCount} docs: ${u.url}`);
      });
    }
  }
}

inspect().catch(console.error);
