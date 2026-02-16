#!/usr/bin/env tsx
/**
 * Reset recently uploaded documents back to pending
 * so they can be re-ingested with proper OCR
 */

import { db, sql } from '../server/storage/db';

async function resetBadUploads() {
  console.log('======================================================================');
  console.log('🔄 Reset Bad Uploads (No OCR)');
  console.log('======================================================================\n');
  
  // Get documents synced in last 30 minutes (the bad batch)
  const badDocs = await db.execute(sql`
    SELECT id, s3_key, gemini_document_id, gemini_store_id
    FROM s3_gemini_sync
    WHERE status = 'synced'
    AND synced_at > NOW() - INTERVAL '30 minutes'
  `);
  
  const docs = badDocs.rows as Array<{
    id: string;
    s3_key: string;
    gemini_document_id: string;
    gemini_store_id: string;
  }>;
  
  console.log(`📊 Found ${docs.length} documents to reset\n`);
  
  if (docs.length === 0) {
    console.log('✅ No documents need resetting\n');
    process.exit(0);
  }
  
  console.log('📝 Documents to reset:');
  for (const doc of docs) {
    console.log(`   ${doc.s3_key}`);
  }
  
  console.log('\n🔄 Resetting status to pending...\n');
  
  // Reset to pending
  await db.execute(sql`
    UPDATE s3_gemini_sync
    SET 
      status = 'pending',
      gemini_document_id = NULL,
      synced_at = NULL,
      error_message = 'Reset for re-ingestion with OCR'
    WHERE status = 'synced'
    AND synced_at > NOW() - INTERVAL '30 minutes'
  `);
  
  console.log(`✅ Reset ${docs.length} documents back to pending status\n`);
  
  console.log('⚠️  Note: Gemini File Search documents still exist in stores.');
  console.log('   They will be overwritten when we re-upload with OCR.\n');
  
  process.exit(0);
}

resetBadUploads().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
