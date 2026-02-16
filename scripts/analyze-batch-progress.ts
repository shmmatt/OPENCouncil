#!/usr/bin/env tsx
/**
 * Analyze batch crawl progress and log patterns
 */

import { db } from '../server/storage/db';
import { crawlerRuns, crawlerUrls, crawlerDocuments, crawlerTowns } from '../shared/crawler-schema';
import { eq, desc } from 'drizzle-orm';

async function analyzeBatchProgress() {
  console.log('📊 Analyzing Batch Crawl Progress\n');
  console.log('='.repeat(70));
  
  // Get all towns
  const towns = await db.select().from(crawlerTowns).orderBy(crawlerTowns.name);
  
  for (const town of towns) {
    // Get latest run
    const [latestRun] = await db.select()
      .from(crawlerRuns)
      .where(eq(crawlerRuns.townId, town.id))
      .orderBy(desc(crawlerRuns.startedAt))
      .limit(1);
    
    if (!latestRun || latestRun.status === 'completed') continue;
    
    console.log(`\n🏛️  ${town.name} (${town.cms})`);
    console.log(`   Run: ${latestRun.status} - ${latestRun.mode}`);
    console.log(`   Pages visited: ${latestRun.pagesVisited || 0}`);
    console.log(`   Docs discovered: ${latestRun.docsDiscovered || 0}`);
    
    // Get URL patterns being visited
    const recentUrls = await db.select()
      .from(crawlerUrls)
      .where(eq(crawlerUrls.townId, town.id))
      .orderBy(desc(crawlerUrls.lastVisited))
      .limit(20);
    
    if (recentUrls.length > 0) {
      console.log(`\n   Recent URLs visited (last 20):`);
      
      // Group by pattern
      const patterns: Record<string, number> = {};
      const docCounts: Record<string, number> = {};
      
      recentUrls.forEach(u => {
        // Extract pattern
        let pattern = u.url.replace(/https?:\/\/[^\/]+/, '');
        pattern = pattern.replace(/\d+/g, 'N'); // Replace numbers with N
        pattern = pattern.replace(/\?.*/, '?...'); // Simplify query params
        
        patterns[pattern] = (patterns[pattern] || 0) + 1;
        docCounts[pattern] = (docCounts[pattern] || 0) + (u.documentCount || 0);
      });
      
      Object.entries(patterns).forEach(([pattern, count]) => {
        const avgDocs = docCounts[pattern] / count;
        console.log(`      ${pattern}: ${count} visits, ${avgDocs.toFixed(1)} docs/page avg`);
      });
    }
    
    // Get sample successful URLs (found docs)
    const successUrls = await db.select()
      .from(crawlerUrls)
      .where(eq(crawlerUrls.townId, town.id))
      .orderBy(desc(crawlerUrls.documentCount))
      .limit(5);
    
    if (successUrls.length > 0 && successUrls[0].documentCount! > 0) {
      console.log(`\n   Top URLs by document count:`);
      successUrls.slice(0, 3).forEach(u => {
        console.log(`      ${u.documentCount} docs: ${u.url.substring(0, 80)}`);
      });
    }
    
    // Get document discovery stats
    const [docStats] = await db.select({
      total: db.$count(crawlerDocuments.id)
    })
    .from(crawlerDocuments)
    .where(eq(crawlerDocuments.townId, town.id));
    
    console.log(`\n   Total documents in state: ${docStats.total}`);
  }
  
  console.log('\n' + '='.repeat(70));
}

async function main() {
  while (true) {
    await analyzeBatchProgress();
    console.log('\n⏰ Next update in 5 minutes...\n');
    await new Promise(resolve => setTimeout(resolve, 300000)); // 5 min
  }
}

main().catch(console.error);
