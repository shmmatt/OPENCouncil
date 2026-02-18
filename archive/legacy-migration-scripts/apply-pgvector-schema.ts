/**
 * Apply pgvector schema changes directly
 */

import { db, sql } from "../server/storage/db";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function applySchema() {
  try {
    console.log("🔧 Applying pgvector schema...");
    
    // Read the SQL file
    const sqlFile = path.join(__dirname, "../migrations/pgvector-manual.sql");
    const sqlContent = await fs.readFile(sqlFile, "utf-8");
    
    // Remove comments and split by semicolon
    const cleanedSql = sqlContent
      .split("\n")
      .filter(line => !line.trim().startsWith("--"))
      .join("\n");
    
    const statements = cleanedSql
      .split(";")
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    console.log(`📝 Executing ${statements.length} SQL statements...`);
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      const firstLine = statement.split("\n")[0].slice(0, 60);
      console.log(`  ${i + 1}/${statements.length}: ${firstLine}...`);
      
      try {
        await db.execute(sql.raw(statement));
        console.log(`    ✅ Success`);
      } catch (error: any) {
        // Ignore "already exists" errors
        if (error.message?.includes("already exists")) {
          console.log(`    ⏭️  Already exists (skipping)`);
        } else {
          console.error(`    ❌ Failed:`, error.message);
          throw error;
        }
      }
    }
    
    console.log("\n✅ Schema applied successfully!");
    console.log("\n📊 Verifying tables...");
    
    // Verify tables exist
    const tablesCheck = await db.execute(sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('document_chunks', 'embedding_jobs')
    `);
    
    console.log(`Found ${tablesCheck.rows.length} pgvector tables:`);
    tablesCheck.rows.forEach((row: any) => {
      console.log(`  - ${row.table_name}`);
    });
    
    // Verify pgvector extension
    const extensionCheck = await db.execute(sql`
      SELECT * FROM pg_extension WHERE extname = 'vector'
    `);
    
    if (extensionCheck.rows.length > 0) {
      console.log("✅ pgvector extension is enabled");
    } else {
      console.log("❌ pgvector extension is NOT enabled");
    }
    
    // Verify indexes
    const indexCheck = await db.execute(sql`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename IN ('document_chunks', 'embedding_jobs')
    `);
    
    console.log(`\n📑 Found ${indexCheck.rows.length} indexes:`);
    indexCheck.rows.forEach((row: any) => {
      console.log(`  - ${row.indexname}`);
    });
    
    console.log("\n🎉 pgvector database setup complete!");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Failed to apply schema:", error);
    process.exit(1);
  }
}

applySchema();
