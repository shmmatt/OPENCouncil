import { db, sql } from "../server/storage/db";

async function getStatus() {
  try {
    // Document counts
    const docVersions = await db.execute(sql`
      SELECT COUNT(*) as count FROM document_versions WHERE is_current = true
    `);
    
    const logicalDocs = await db.execute(sql`
      SELECT COUNT(*) as count FROM logical_documents
    `);
    
    const docsByTown = await db.execute(sql`
      SELECT ld.town, COUNT(*) as count
      FROM document_versions dv
      JOIN logical_documents ld ON dv.document_id = ld.id
      WHERE dv.is_current = true
      GROUP BY ld.town
      ORDER BY count DESC
      LIMIT 15
    `);
    
    // Embedding progress
    const embeddingStats = await db.execute(sql`
      SELECT COUNT(*) as total_chunks FROM document_chunks
    `);
    
    const embeddingJobs = await db.execute(sql`
      SELECT status, COUNT(*) as count
      FROM embedding_jobs
      GROUP BY status
    `);
    
    const embeddedTowns = await db.execute(sql`
      SELECT town, COUNT(DISTINCT document_version_id) as doc_count, COUNT(*) as chunk_count
      FROM document_chunks
      GROUP BY town
      ORDER BY chunk_count DESC
    `);
    
    // Crawler state (may not exist in production)
    let crawlerState = { rows: [] };
    try {
      crawlerState = await db.execute(sql`
        SELECT town, status, last_crawl_at
        FROM crawler_state
        ORDER BY last_crawl_at DESC NULLS LAST
        LIMIT 10
      `);
    } catch (e) {
      // Table doesn't exist, skip
    }
    
    console.log("\n📊 OPENCouncil System Status\n");
    console.log("=" .repeat(60));
    
    console.log("\n📚 DOCUMENTS:");
    console.log(`  Total logical documents: ${logicalDocs.rows[0].count}`);
    console.log(`  Current document versions: ${docVersions.rows[0].count}`);
    console.log("\n  Top 15 towns by document count:");
    docsByTown.rows.forEach((r: any) => {
      console.log(`    ${r.town.padEnd(20)} ${r.count.toString().padStart(4)} docs`);
    });
    
    console.log("\n🧠 PGVECTOR EMBEDDINGS:");
    console.log(`  Total chunks embedded: ${embeddingStats.rows[0].total_chunks}`);
    console.log("\n  Embedding jobs by status:");
    embeddingJobs.rows.forEach((r: any) => {
      console.log(`    ${r.status.padEnd(15)} ${r.count}`);
    });
    
    if (embeddedTowns.rows.length > 0) {
      console.log("\n  Embedded towns:");
      embeddedTowns.rows.forEach((r: any) => {
        console.log(`    ${r.town.padEnd(20)} ${r.doc_count} docs, ${r.chunk_count} chunks`);
      });
    } else {
      console.log("\n  ⚠️  No documents embedded yet");
    }
    
    console.log("\n🕷️  CRAWLER STATE (last 10):");
    if (crawlerState.rows.length > 0) {
      crawlerState.rows.forEach((r: any) => {
        const lastCrawl = r.last_crawl_at ? new Date(r.last_crawl_at).toISOString().split('T')[0] : 'never';
        console.log(`    ${r.town.padEnd(20)} ${r.status.padEnd(15)} ${lastCrawl}`);
      });
    } else {
      console.log("    No crawler state found");
    }
    
    console.log("\n" + "=".repeat(60));
    
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

getStatus();
