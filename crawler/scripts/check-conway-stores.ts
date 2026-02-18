import 'dotenv/config';
import { db, sql } from '../server/storage/db';

async function main() {
  const result = await db.execute(sql`
    SELECT gemini_store_id, status, COUNT(*) as count
    FROM s3_gemini_sync
    WHERE town = 'conway'
    GROUP BY gemini_store_id, status
    ORDER BY count DESC
  `);
  
  console.log('Conway store breakdown:');
  result.rows.forEach((row: any) => {
    console.log(`  ${row.gemini_store_id}`);
    console.log(`    Status: ${row.status}, Count: ${row.count}`);
  });
}

main().catch(console.error);
