import { db, sql } from "../server/storage/db";

async function checkTables() {
  try {
    console.log("📊 Checking document_chunks table...\n");
    
    const columns = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'document_chunks' 
      ORDER BY ordinal_position
    `);
    
    console.log(`Found ${columns.rows.length} columns:`);
    columns.rows.forEach((r: any) => {
      console.log(`  - ${r.column_name}: ${r.data_type} (nullable: ${r.is_nullable})`);
    });
    
    console.log("\n📊 Checking embedding_jobs table...\n");
    
    const jobColumns = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'embedding_jobs' 
      ORDER BY ordinal_position
    `);
    
    console.log(`Found ${jobColumns.rows.length} columns:`);
    jobColumns.rows.forEach((r: any) => {
      console.log(`  - ${r.column_name}: ${r.data_type} (nullable: ${r.is_nullable})`);
    });
    
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

checkTables();
