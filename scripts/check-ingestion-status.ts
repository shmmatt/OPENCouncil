#!/usr/bin/env tsx
import "dotenv/config";
import { db, sql } from '../server/storage/db';

async function main() {
  const stats = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'synced') as synced,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) as total
    FROM s3_gemini_sync
  `);

  const row = stats.rows[0] as any;
  console.log('📊 Ingestion Status:');
  console.log('   Total in sync table: ' + row.total);
  console.log('   Pending ingestion:   ' + row.pending);
  console.log('   Already synced:      ' + row.synced);
  console.log('   Failed:              ' + row.failed);
  
  process.exit(0);
}

main();
