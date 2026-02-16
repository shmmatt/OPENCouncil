#!/usr/bin/env tsx
import { db } from '../server/storage/db';
import { crawlerDocuments, crawlerTowns } from '../shared/crawler-schema';
import { eq } from 'drizzle-orm';

async function main() {
  const slug = process.argv[2] || 'harts-location';
  
  const [town] = await db.select().from(crawlerTowns).where(eq(crawlerTowns.slug, slug));
  
  if (!town) {
    console.log(`Town '${slug}' not found in database`);
    process.exit(1);
  }
  
  console.log(`\n📊 ${town.name} (${town.slug})`);
  console.log('='.repeat(50));
  
  const docs = await db.select().from(crawlerDocuments).where(eq(crawlerDocuments.townId, town.id));
  
  console.log(`Total documents: ${docs.length}`);
  
  if (docs.length > 0) {
    const statuses = docs.reduce((acc: any, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {});
    
    console.log('\nBy status:');
    Object.entries(statuses).forEach(([status, count]) => {
      console.log(`  ${status}: ${count}`);
    });
    
    console.log('\nSample documents (first 5):');
    docs.slice(0, 5).forEach(d => {
      console.log(`  ${d.status.padEnd(12)} ${d.filename}`);
    });
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
