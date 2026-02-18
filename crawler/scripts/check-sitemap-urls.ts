import pkg from 'pg';
const { Client } = pkg;

const townSlug = process.argv[2];

if (!townSlug) {
  console.error('Usage: tsx check-sitemap-urls.ts <town-slug>');
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Get town
    const townResult = await client.query(
      'SELECT * FROM crawler_towns WHERE slug = $1',
      [townSlug]
    );

    if (townResult.rows.length === 0) {
      console.error(`Town not found: ${townSlug}`);
      process.exit(1);
    }

    const town = townResult.rows[0];

    // Get latest sitemap
    const sitemapResult = await client.query(
      'SELECT * FROM crawler_sitemaps WHERE town_id = $1 ORDER BY discovered_at DESC LIMIT 1',
      [town.id]
    );

    if (sitemapResult.rows.length === 0) {
      console.error(`No sitemap found for ${townSlug}`);
      process.exit(1);
    }

    const sitemap = sitemapResult.rows[0];

    console.log(`\n🗺️  Latest Sitemap for ${town.name}`);
    console.log(`   URL Count: ${sitemap.url_count}`);
    console.log(`   Hash: ${sitemap.hash.slice(0, 16)}...`);
    console.log(`   Discovered: ${sitemap.discovered_at}\n`);

    // Get URLs from this town (not linked to sitemap in schema)
    const urlsResult = await client.query(
      `SELECT url, document_count, last_visited 
       FROM crawler_urls 
       WHERE town_id = $1 
       ORDER BY document_count DESC NULLS LAST, last_visited DESC 
       LIMIT 20`,
      [town.id]
    );

    const urls = urlsResult.rows;

    console.log(`📄 Top URLs by Document Count (showing ${urls.length}):\n`);
    urls.forEach(url => {
      console.log(`   ${url.document_count || 0} docs  →  ${url.url}`);
    });

    const totalDocs = urls.reduce((sum, u) => sum + (u.document_count || 0), 0);
    console.log(`\n   Total docs from shown URLs: ${totalDocs}`);

    // Show sample of actual documents in DB
    const docsResult = await client.query(
      `SELECT url, filename, status 
       FROM crawler_documents 
       WHERE town_id = $1 
       ORDER BY discovered_at DESC 
       LIMIT 5`,
      [town.id]
    );

    if (docsResult.rows.length > 0) {
      console.log(`\n📚 Sample Documents in Database (${docsResult.rows.length} shown):\n`);
      docsResult.rows.forEach(doc => {
        console.log(`   [${doc.status}] ${doc.filename}`);
        console.log(`      ${doc.url}`);
      });
    } else {
      console.log(`\n📚 No documents found in database for this town`);
    }

  } finally {
    await client.end();
  }
}

main().catch(console.error);
