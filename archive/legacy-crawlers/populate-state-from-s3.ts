#!/usr/bin/env tsx
/**
 * Populate crawler state from existing S3/DB data
 * 
 * Since we already have documents in S3 (via backfill), and those are
 * already in crawler_documents table, we can populate the discovered count
 * by simply counting those records.
 * 
 * This solves the issue where new crawls can't find documents that were
 * discovered by previous methods (old crawler, manual uploads, etc.)
 */

import { db } from '../server/storage/db';
import { crawlerTowns, crawlerDocuments } from '../shared/crawler-schema';
import { eq, count, sql } from 'drizzle-orm';

async function populateStateFromExisting() {
  console.log('📊 Populating crawler state from existing S3/DB data...\n');
  
  // Get all towns
  const towns = await db.select().from(crawlerTowns);
  
  console.log(`Found ${towns.length} towns\n`);
  
  for (const town of towns) {
    console.log(`Processing ${town.name}...`);
    
    // Count documents already in DB for this town
    const [result] = await db
      .select({ count: count() })
      .from(crawlerDocuments)
      .where(eq(crawlerDocuments.townId, town.id));
    
    const docCount = result.count;
    
    if (docCount > 0) {
      // Update town stats
      await db.update(crawlerTowns)
        .set({
          totalDocumentsDiscovered: docCount,
          lastCrawlFoundDocuments: docCount,
        })
        .where(eq(crawlerTowns.id, town.id));
      
      console.log(`  ✅ Updated: ${docCount} documents`);
    } else {
      console.log(`  ⚠️  No documents found`);
    }
  }
  
  console.log('\n✅ State population complete!');
  console.log('\nRun: npm run state:inspect -- --all');
}

populateStateFromExisting().catch(console.error);
