#!/usr/bin/env tsx
import { db } from '../server/storage/db';
import { crawlerDocuments, crawlerTowns } from '../shared/crawler-schema';
import { eq, sql } from 'drizzle-orm';

async function main() {
  // Check uploaded documents by town
  const result = await db.execute(sql`
    SELECT 
      t.name,
      t.slug,
      COUNT(*) as total_docs,
      SUM(CASE WHEN d.status = 'uploaded' THEN 1 ELSE 0 END) as uploaded,
      SUM(CASE WHEN d.status = 'discovered' THEN 1 ELSE 0 END) as discovered,
      MIN(d.s3_uploaded_at) as first_upload,
      MAX(d.s3_uploaded_at) as last_upload
    FROM crawler_documents d
    JOIN crawler_towns t ON d.town_id = t.id
    GROUP BY t.name, t.slug
    ORDER BY uploaded DESC
  `);
  
  console.log('\n📊 Documents by Town\n');
  console.log('Town                 | Uploaded | Discovered | First Upload        | Last Upload');
  console.log('-'.repeat(90));
  
  const rows = result.rows || result;
  for (const row of rows) {
    const name = String(row.name).padEnd(18);
    const uploaded = String(row.uploaded).padStart(8);
    const discovered = String(row.discovered).padStart(10);
    const first = row.first_upload ? new Date(row.first_upload).toISOString().slice(0, 10) : 'never';
    const last = row.last_upload ? new Date(row.last_upload).toISOString().slice(0, 10) : 'never';
    
    console.log(`${name} | ${uploaded} | ${discovered} | ${first.padEnd(19)} | ${last}`);
  }
  
  // Check when the uploads happened
  const recentUploads = await db.execute(sql`
    SELECT 
      t.slug,
      d.filename,
      d.s3_uploaded_at,
      d.discovered_at
    FROM crawler_documents d
    JOIN crawler_towns t ON d.town_id = t.id
    WHERE d.status = 'uploaded'
    ORDER BY d.s3_uploaded_at DESC
    LIMIT 10
  `);
  
  console.log('\n📅 Recent Uploads (last 10):');
  console.log('-'.repeat(90));
  
  const uploads = recentUploads.rows || recentUploads;
  for (const upload of uploads) {
    const uploaded = upload.s3_uploaded_at 
      ? new Date(upload.s3_uploaded_at).toISOString().slice(0, 19).replace('T', ' ')
      : 'unknown';
    console.log(`${uploaded} | ${upload.slug} | ${upload.filename}`);
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
