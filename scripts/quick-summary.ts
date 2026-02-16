import pkg from 'pg';
const { Client } = pkg;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const result = await client.query(`
    SELECT 
      name,
      last_full_crawl,
      last_crawl_docs_found,
      total_documents,
      total_uploaded
    FROM crawler_towns
    WHERE county = 'Carroll'
    ORDER BY last_full_crawl DESC NULLS LAST, name
  `);

  console.log('\n📊 Carroll County Crawl Status:\n');
  console.log('Town                   Last Crawl          Docs Found  Total Docs');
  console.log('─────────────────────  ──────────────────  ──────────  ──────────');
  
  let totalDocs = 0;
  let crawledCount = 0;
  
  result.rows.forEach(row => {
    const lastCrawl = row.last_full_crawl 
      ? new Date(row.last_full_crawl).toLocaleString('en-US', { 
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' 
        })
      : 'Never';
    
    if (row.last_full_crawl && new Date(row.last_full_crawl) > new Date('2026-02-13T18:00:00Z')) {
      crawledCount++;
      totalDocs += row.last_crawl_docs_found || 0;
    }
    
    console.log(
      `${row.name.padEnd(22)} ${lastCrawl.padEnd(19)} ${String(row.last_crawl_docs_found || 0).padStart(10)}  ${String(row.total_documents).padStart(10)}`
    );
  });

  console.log('\n📈 Today\'s Progress:');
  console.log(`   Towns completed: ${crawledCount}/17`);
  console.log(`   Documents discovered: ${totalDocs.toLocaleString()}`);

  await client.end();
}

main().catch(console.error);
