import { db } from '../server/storage/db';
import { s3GeminiSync } from '../shared/schema';
import { eq, sql } from 'drizzle-orm';

async function resetFailedDocs() {
  console.log('🔄 Resetting failed documents to pending status...');
  
  const result = await db
    .update(s3GeminiSync)
    .set({ status: 'pending', error: null })
    .where(eq(s3GeminiSync.status, 'failed'));
  
  console.log(`✅ Reset failed documents to pending`);
  
  const check = await db
    .select({
      status: s3GeminiSync.status,
      count: sql<number>`count(*)`.as('count')
    })
    .from(s3GeminiSync)
    .groupBy(s3GeminiSync.status);
  
  console.log('\n📊 New status:');
  check.forEach(row => {
    console.log(`  ${row.status}: ${row.count}`);
  });
}

resetFailedDocs().catch(console.error);
