import pkg from 'pg';
const { Client } = pkg;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const result = await client.query(
    `SELECT name, slug, cms, total_documents, last_crawl_docs_found 
     FROM crawler_towns 
     WHERE cms = 'WordPress' 
     ORDER BY total_documents DESC`
  );

  console.log('\n📊 WordPress Towns in Carroll County:\n');
  result.rows.forEach(row => {
    console.log(`  ${row.name.padEnd(20)} | Docs: ${String(row.total_documents).padStart(3)} | Last crawl: ${row.last_crawl_docs_found}`);
  });
  console.log(`\n  Total WordPress towns: ${result.rows.length}`);

  await client.end();
}

main().catch(console.error);
