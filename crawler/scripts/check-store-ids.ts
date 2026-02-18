import 'dotenv/config';
import { db, sql } from '../server/storage/db';

async function main() {
  // Get unique store IDs from synced files
  const result = await db.execute(sql`
    SELECT 
      gemini_store_id,
      town,
      COUNT(*) as file_count,
      SUM(size_bytes) as total_bytes
    FROM s3_gemini_sync
    WHERE status = 'synced'
    GROUP BY gemini_store_id, town
    ORDER BY file_count DESC
  `);
  
  console.log('📊 Gemini Stores in Database:\n');
  
  let grandTotal = 0;
  let grandBytes = 0;
  
  for (const row of result.rows as any[]) {
    const gb = (row.total_bytes / 1024 / 1024 / 1024).toFixed(2);
    console.log(`${row.town.padEnd(20)} ${row.gemini_store_id}`);
    console.log(`  ${row.file_count} files, ${gb} GB\n`);
    grandTotal += parseInt(row.file_count);
    grandBytes += parseInt(row.total_bytes);
  }
  
  const totalGB = (grandBytes / 1024 / 1024 / 1024).toFixed(2);
  console.log(`Total: ${grandTotal} files, ${totalGB} GB`);
  
  // Check which API key
  console.log(`\nAPI Key being used: ${process.env.GEMINI_API_KEY?.substring(0, 20)}...`);
}

main().catch(console.error);
