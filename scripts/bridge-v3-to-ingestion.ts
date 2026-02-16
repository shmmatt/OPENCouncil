#!/usr/bin/env tsx
/**
 * Bridge V3 Crawler Documents to Ingestion Pipeline
 * 
 * Creates s3_gemini_sync records from crawler_documents
 * so the existing ingestion worker can process them.
 */

import { db, sql } from '../server/storage/db';

interface BridgeResult {
  created: number;
  skipped: number;
  failed: number;
}

/**
 * Bridge V3 documents to ingestion pipeline
 */
async function bridgeV3Documents(batchSize = 1000): Promise<BridgeResult> {
  const result: BridgeResult = {
    created: 0,
    skipped: 0,
    failed: 0
  };
  
  console.log('======================================================================');
  console.log('🌉 Bridge V3 Documents to Ingestion Pipeline');
  console.log('======================================================================\n');
  
  // Get uploaded V3 documents with extracted metadata that aren't already in sync table
  console.log('📊 Querying V3 documents ready for ingestion...');
  const v3Docs = await db.execute(sql`
    SELECT 
      cd.id,
      cd.s3_key,
      cd.category,
      cd.board,
      cd.year,
      cd.size_bytes,
      t.slug as town_slug
    FROM crawler_documents cd
    JOIN crawler_towns t ON cd.town_id = t.id
    LEFT JOIN s3_gemini_sync sgs ON cd.s3_key = sgs.s3_key
    WHERE cd.status = 'uploaded'
    AND cd.s3_key IS NOT NULL
    AND cd.category IS NOT NULL
    AND sgs.id IS NULL
    LIMIT ${batchSize}
  `);
  
  const rows = v3Docs.rows as Array<{
    id: string;
    s3_key: string;
    category: string | null;
    board: string | null;
    year: string | null;
    size_bytes: number | null;
    town_slug: string;
  }>;
  
  console.log(`   Found ${rows.length} documents ready for ingestion\n`);
  
  if (rows.length === 0) {
    console.log('✅ No documents to bridge. Exiting.\n');
    return result;
  }
  
  console.log('🔗 Creating s3_gemini_sync records...\n');
  
  for (const doc of rows) {
    try {
      // Check if already exists in s3_gemini_sync
      const existingCheck = await db.execute(sql`
        SELECT id FROM s3_gemini_sync
        WHERE s3_key = ${doc.s3_key}
        LIMIT 1
      `);
      
      if (existingCheck.rows.length > 0) {
        result.skipped++;
        continue;
      }
      
      // Create s3_gemini_sync record
      await db.execute(sql`
        INSERT INTO s3_gemini_sync (
          s3_key,
          gemini_store_id,
          town,
          category,
          board,
          year,
          size_bytes,
          status,
          created_at
        ) VALUES (
          ${doc.s3_key},
          ${'pending_' + doc.town_slug},
          ${doc.town_slug},
          ${doc.category},
          ${doc.board},
          ${doc.year},
          ${doc.size_bytes},
          'pending',
          NOW()
        )
      `);
      
      result.created++;
      
      if (result.created % 100 === 0) {
        console.log(`   Created ${result.created} records...`);
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`   ❌ Failed to bridge ${doc.s3_key}: ${errorMsg}`);
      result.failed++;
    }
  }
  
  console.log(`\n✅ Bridge complete:`);
  console.log(`   Created: ${result.created}`);
  console.log(`   Skipped: ${result.skipped} (already exist)`);
  console.log(`   Failed: ${result.failed}\n`);
  
  return result;
}

/**
 * Get bridge statistics
 */
async function getBridgeStats() {
  console.log('📊 Bridge Statistics:\n');
  
  // V3 documents ready
  const v3Ready = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM crawler_documents
    WHERE status = 'uploaded'
    AND s3_key IS NOT NULL
    AND category IS NOT NULL
  `);
  
  // Already in sync table
  const inSync = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM s3_gemini_sync
  `);
  
  // Pending ingestion
  const pending = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM s3_gemini_sync
    WHERE status = 'pending'
  `);
  
  // Already synced
  const synced = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM s3_gemini_sync
    WHERE status = 'synced'
  `);
  
  const v3Count = Number(v3Ready.rows[0]?.count || 0);
  const syncCount = Number(inSync.rows[0]?.count || 0);
  const pendingCount = Number(pending.rows[0]?.count || 0);
  const syncedCount = Number(synced.rows[0]?.count || 0);
  
  console.log(`V3 Documents Ready:      ${v3Count}`);
  console.log(`In Sync Table:           ${syncCount}`);
  console.log(`   Pending Ingestion:    ${pendingCount}`);
  console.log(`   Already Synced:       ${syncedCount}`);
  console.log(`\nNeed to Bridge:          ${Math.max(0, v3Count - syncCount)}\n`);
  
  return {
    v3Ready: v3Count,
    inSync: syncCount,
    pending: pendingCount,
    synced: syncedCount,
    needBridge: Math.max(0, v3Count - syncCount)
  };
}

/**
 * Main execution
 */
async function main() {
  // Show initial stats
  const initialStats = await getBridgeStats();
  
  if (initialStats.needBridge === 0) {
    console.log('✅ All V3 documents are already bridged. Nothing to do.\n');
    process.exit(0);
  }
  
  console.log(`\n🚀 Bridging ${initialStats.needBridge} documents...\n`);
  
  // Bridge documents in batches
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  
  while (true) {
    const result = await bridgeV3Documents(1000);
    
    totalCreated += result.created;
    totalSkipped += result.skipped;
    totalFailed += result.failed;
    
    if (result.created === 0) {
      break;
    }
  }
  
  // Show final stats
  console.log('\n' + '='.repeat(70));
  console.log('📊 FINAL RESULTS');
  console.log('='.repeat(70) + '\n');
  
  console.log(`Total Created:  ${totalCreated}`);
  console.log(`Total Skipped:  ${totalSkipped}`);
  console.log(`Total Failed:   ${totalFailed}\n`);
  
  const finalStats = await getBridgeStats();
  
  console.log('✅ V3 documents are now ready for ingestion!');
  console.log(`   Pending ingestion: ${finalStats.pending}\n`);
  
  console.log('🚀 Next step: Run ingestion worker');
  console.log('   tsx server/services/ingestionWorker.ts\n');
  
  process.exit(0);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
