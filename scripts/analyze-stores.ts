import 'dotenv/config';
import { db, sql } from '../server/storage/db';

async function main() {
  console.log('📊 Analyzing Town Stores\n');
  
  // Get all unique towns and their stores
  const result = await db.execute(sql`
    SELECT 
      town,
      gemini_store_id,
      COUNT(*) as file_count,
      MIN(created_at) as first_upload,
      MAX(created_at) as last_upload
    FROM s3_gemini_sync
    WHERE status = 'synced'
    GROUP BY town, gemini_store_id
    ORDER BY town, file_count DESC
  `);
  
  const townGroups = new Map<string, any[]>();
  
  for (const row of result.rows as any[]) {
    if (!townGroups.has(row.town)) {
      townGroups.set(row.town, []);
    }
    townGroups.get(row.town)!.push(row);
  }
  
  console.log('Towns with multiple stores:\n');
  
  for (const [town, stores] of townGroups.entries()) {
    if (stores.length > 1) {
      console.log(`${town.toUpperCase()}:`);
      stores.forEach((store, idx) => {
        const primary = idx === 0 ? '✅ PRIMARY' : '❌ DUPLICATE';
        console.log(`  ${primary} ${store.gemini_store_id}`);
        console.log(`    Files: ${store.file_count}`);
        console.log(`    First: ${store.first_upload}`);
        console.log(`    Last:  ${store.last_upload}`);
      });
      console.log('');
    }
  }
  
  console.log('\nRecommendation:');
  console.log('- Keep the store with the most files for each town');
  console.log('- Mark documents in other stores as pending to re-upload');
  console.log('- Update s3Sync.ts to check database before creating stores');
}

main().catch(console.error);
