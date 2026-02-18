#!/usr/bin/env tsx
/**
 * Download Worker Runner
 * 
 * Processes all discovered documents in batches
 */

import { processDiscoveredDocuments, getDownloadWorkerStats } from '../server/workers/downloadWorker';

async function main() {
  const batchSize = 50; // Process 50 at a time
  const delayMs = 2000; // 2 second delay between batches
  
  console.log('======================================================================');
  console.log('📥 Download Worker - Processing Discovered Documents');
  console.log('======================================================================\n');
  
  // Get initial stats
  const initialStats = await getDownloadWorkerStats();
  console.log(`📊 Initial Status:`);
  console.log(`   Discovered: ${initialStats.discovered}`);
  console.log(`   Uploaded:   ${initialStats.uploaded}`);
  console.log(`   Failed:     ${initialStats.failed}`);
  console.log(`   Pending:    ${initialStats.pending}\n`);
  
  if (initialStats.pending === 0) {
    console.log('✅ No documents to process. Exiting.\n');
    process.exit(0);
  }
  
  console.log(`🚀 Starting batch processing...`);
  console.log(`   Batch size: ${batchSize}`);
  console.log(`   Delay: ${delayMs}ms\n`);
  
  let totalProcessed = 0;
  let totalUploaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let batchNum = 0;
  
  const startTime = Date.now();
  
  while (true) {
    batchNum++;
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📦 Batch ${batchNum}`);
    console.log('='.repeat(70));
    
    const result = await processDiscoveredDocuments(batchSize);
    
    if (result.processed === 0) {
      console.log('✅ No more documents to process\n');
      break;
    }
    
    totalProcessed += result.processed;
    totalUploaded += result.uploaded;
    totalSkipped += result.skipped;
    totalFailed += result.failed;
    
    // Progress update
    const currentStats = await getDownloadWorkerStats();
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const rate = totalProcessed / (Date.now() - startTime) * 1000 * 60; // per minute
    
    console.log(`\n📊 Progress:`);
    console.log(`   Batch: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.failed} failed`);
    console.log(`   Total: ${totalUploaded} uploaded, ${totalSkipped} skipped, ${totalFailed} failed`);
    console.log(`   Remaining: ${currentStats.pending} documents`);
    console.log(`   Rate: ${rate.toFixed(1)} docs/min`);
    console.log(`   Elapsed: ${elapsed} minutes`);
    
    if (currentStats.pending > 0) {
      const eta = (currentStats.pending / rate).toFixed(1);
      console.log(`   ETA: ${eta} minutes`);
    }
    
    // Show recent errors if any
    if (result.errors.length > 0) {
      console.log(`\n⚠️  Recent Errors (${result.errors.length}):`);
      result.errors.slice(0, 5).forEach(e => {
        console.log(`   ${e.url}`);
        console.log(`      ${e.error}`);
      });
      if (result.errors.length > 5) {
        console.log(`   ... and ${result.errors.length - 5} more`);
      }
    }
    
    // Delay before next batch (to avoid overwhelming servers)
    if (currentStats.pending > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  // Final summary
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const finalStats = await getDownloadWorkerStats();
  
  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 FINAL SUMMARY');
  console.log('='.repeat(70));
  console.log(`✅ Processed: ${totalProcessed} documents`);
  console.log(`📤 Uploaded: ${totalUploaded} to S3`);
  console.log(`⏭️  Skipped: ${totalSkipped} (already in S3)`);
  console.log(`❌ Failed: ${totalFailed}`);
  console.log(`⏱️  Duration: ${duration} minutes`);
  console.log(`⚡ Rate: ${(totalProcessed / parseFloat(duration)).toFixed(1)} docs/min\n`);
  
  console.log('📊 Final Database Status:');
  console.log(`   Uploaded:   ${finalStats.uploaded}`);
  console.log(`   Failed:     ${finalStats.failed}`);
  console.log(`   Pending:    ${finalStats.pending}\n`);
  
  if (totalFailed > 0) {
    console.log('⚠️  Some downloads failed. Review errors above.');
    console.log('   You can retry failed downloads with:');
    console.log('   tsx scripts/retry-failed-downloads.ts\n');
  }
  
  process.exit(0);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
