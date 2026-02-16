import pkg from 'pg';
const { Client } = pkg;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Get actual document counts by CMS
  const result = await client.query(
    `SELECT 
      ct.name, 
      ct.cms, 
      ct.total_documents as stat_count,
      COUNT(cd.id) as actual_count,
      ct.last_crawl_docs_found
     FROM crawler_towns ct
     LEFT JOIN crawler_documents cd ON cd.town_id = ct.id
     GROUP BY ct.id, ct.name, ct.cms, ct.total_documents, ct.last_crawl_docs_found
     ORDER BY actual_count DESC`
  );

  console.log('\n📊 Document Counts by Town (CMS):\n');
  console.log('Town                   CMS           Stat  Actual  Last');
  console.log('─────────────────────  ────────────  ────  ──────  ────');
  
  result.rows.forEach(row => {
    console.log(
      `${row.name.padEnd(22)} ${(row.cms || 'Unknown').padEnd(13)} ` +
      `${String(row.stat_count).padStart(4)}  ` +
      `${String(row.actual_count).padStart(6)}  ` +
      `${String(row.last_crawl_docs_found).padStart(4)}`
    );
  });

  // CMS summary
  const cmsSummary = await client.query(
    `SELECT 
      ct.cms,
      COUNT(DISTINCT ct.id) as town_count,
      SUM(CASE WHEN cd.id IS NOT NULL THEN 1 ELSE 0 END) as total_docs
     FROM crawler_towns ct
     LEFT JOIN crawler_documents cd ON cd.town_id = ct.id
     GROUP BY ct.cms
     ORDER BY total_docs DESC`
  );

  console.log('\n📈 Summary by CMS:\n');
  console.log('CMS           Towns  Documents');
  console.log('────────────  ─────  ─────────');
  cmsSummary.rows.forEach(row => {
    console.log(
      `${(row.cms || 'Unknown').padEnd(13)} ${String(row.town_count).padStart(5)}  ${String(row.total_docs).padStart(9)}`
    );
  });

  await client.end();
}

main().catch(console.error);
