import pkg from 'pg';
const { Client } = pkg;

const townSlug = process.argv[2];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const query = townSlug 
      ? `SELECT ct.name, cd.url, cd.filename, cd.error_message, cd.discovered_at
         FROM crawler_documents cd
         JOIN crawler_towns ct ON ct.id = cd.town_id
         WHERE ct.slug = $1 AND cd.status = 'failed'
         ORDER BY cd.discovered_at DESC
         LIMIT 20`
      : `SELECT ct.name, cd.url, cd.filename, cd.error_message, cd.discovered_at
         FROM crawler_documents cd
         JOIN crawler_towns ct ON ct.id = cd.town_id
         WHERE cd.status = 'failed'
         ORDER BY cd.discovered_at DESC
         LIMIT 50`;
    
    const result = await client.query(query, townSlug ? [townSlug] : []);

    if (result.rows.length === 0) {
      console.log('✅ No failed documents found!');
    } else {
      console.log(`\n❌ Failed Documents (${result.rows.length}):\n`);
      result.rows.forEach((row, i) => {
        console.log(`${i + 1}. ${row.name} - ${row.filename}`);
        console.log(`   URL: ${row.url}`);
        console.log(`   Error: ${row.error_message || 'No error message'}`);
        console.log(`   Time: ${row.discovered_at}\n`);
      });
    }

  } finally {
    await client.end();
  }
}

main().catch(console.error);
