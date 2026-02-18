import { db, sql } from "../server/storage/db";

async function checkProgress() {
  try {
    const chunks = await db.execute(sql`SELECT COUNT(*) as count FROM document_chunks`);
    const jobs = await db.execute(sql`
      SELECT status, COUNT(*) as count 
      FROM embedding_jobs 
      GROUP BY status
    `);
    
    const towns = await db.execute(sql`
      SELECT town, COUNT(*) as count 
      FROM document_chunks 
      GROUP BY town 
      ORDER BY count DESC 
      LIMIT 10
    `);
    
    console.log("\n📊 Embedding Progress:");
    console.log(`Total chunks: ${chunks.rows[0].count}`);
    console.log(`\nEmbedding jobs by status:`);
    jobs.rows.forEach((r: any) => console.log(`  ${r.status}: ${r.count}`));
    console.log(`\nTop towns by chunks:`);
    towns.rows.forEach((r: any) => console.log(`  ${r.town}: ${r.count}`));
    
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

checkProgress();
