#!/usr/bin/env tsx
import 'dotenv/config';
import { db, sql } from '../server/storage/db';

async function checkFailedErrors() {
  console.log('🔍 Checking failed document error messages...\n');
  
  const errorGroups = await db.execute(sql`
    SELECT error_message, COUNT(*) as count
    FROM s3_gemini_sync
    WHERE status = 'failed'
    GROUP BY error_message
    ORDER BY count DESC
    LIMIT 20
  `);
  
  console.log('Top error messages:');
  errorGroups.rows.forEach((group: any, i: number) => {
    console.log(`\n${i + 1}. Count: ${group.count}`);
    console.log(`   Error: ${group.error_message?.substring(0, 200) || 'null'}${group.error_message && group.error_message.length > 200 ? '...' : ''}`);
  });
  
  // Sample a few failed documents
  console.log('\n\n📄 Sample failed documents:');
  const samples = await db.execute(sql`
    SELECT *
    FROM s3_gemini_sync
    WHERE status = 'failed'
    LIMIT 5
  `);
  
  samples.rows.forEach((doc: any, i: number) => {
    console.log(`\n${i + 1}. ${doc.s3_key}`);
    console.log(`   Town: ${doc.town}`);
    console.log(`   Store ID: ${doc.gemini_store_id || 'none'}`);
    console.log(`   Error: ${doc.error_message?.substring(0, 300)}`);
  });
  
  process.exit(0);
}

checkFailedErrors().catch(console.error);
