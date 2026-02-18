import 'dotenv/config';
import { db, sql } from '../server/storage/db';

// Define primary stores (the ones with the most files)
const PRIMARY_STORES: Record<string, string> = {
  'albany': 'fileSearchStores/opencouncil-albany-ybjkjkb92su3',
  'bartlett': 'fileSearchStores/opencouncil-bartlett-kl6obdf9xprj',
  'brookfield': 'fileSearchStores/opencouncil-brookfield-i6s0atryka3w',
  'chatham': 'fileSearchStores/opencouncil-chatham-bebyk1huasog',
  'conway': 'fileSearchStores/opencouncil-conway-3k038dkugi1y',
  'eaton': 'fileSearchStores/opencouncil-eaton-66b67yz8ym4x',
  'effingham': 'fileSearchStores/opencouncil-effingham-r8kub4cu0ihp',
  'freedom': 'fileSearchStores/opencouncil-freedom-jq81md2z2wsl',
  'ossipee': 'fileSearchStores/opencouncil-ossipee-efnhpf60017r',
  'tamworth': 'fileSearchStores/opencouncil-tamworth-r8i5mum6xfqp',
};

async function main() {
  console.log('🔄 Consolidating Town Stores\n');
  
  let totalUpdated = 0;
  
  for (const [town, primaryStore] of Object.entries(PRIMARY_STORES)) {
    console.log(`Processing ${town}...`);
    
    // Mark documents in non-primary stores as pending for re-upload
    const result = await db.execute(sql`
      UPDATE s3_gemini_sync
      SET 
        status = 'pending',
        gemini_store_id = ${primaryStore},
        error_message = NULL
      WHERE town = ${town}
        AND gemini_store_id != ${primaryStore}
        AND status = 'synced'
    `);
    
    if (result.rowsAffected && result.rowsAffected > 0) {
      console.log(`  ✅ Marked ${result.rowsAffected} documents for re-upload to primary store`);
      totalUpdated += result.rowsAffected;
    } else {
      console.log(`  ℹ️  No duplicate stores found`);
    }
  }
  
  console.log(`\n✅ Total: ${totalUpdated} documents marked for consolidation`);
  console.log('\nNext steps:');
  console.log('1. Review the changes');
  console.log('2. Resume ingestion worker to re-upload to primary stores');
  console.log('3. Once complete, old duplicate stores can be deleted from Gemini');
}

main().catch(console.error);
