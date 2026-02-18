import { db, sql } from "../server/storage/db";

async function resetTables() {
  try {
    console.log("🗑️  Dropping existing pgvector tables...\n");
    
    await db.execute(sql`DROP TABLE IF EXISTS document_chunks CASCADE`);
    console.log("✅ Dropped document_chunks");
    
    await db.execute(sql`DROP TABLE IF EXISTS embedding_jobs CASCADE`);
    console.log("✅ Dropped embedding_jobs");
    
    console.log("\n🔧 Creating pgvector extension...\n");
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    console.log("✅ pgvector extension enabled");
    
    console.log("\n📦 Creating document_chunks table...\n");
    await db.execute(sql`
      CREATE TABLE document_chunks (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        document_version_id VARCHAR NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding vector(768) NOT NULL,
        town TEXT NOT NULL,
        category TEXT NOT NULL,
        board TEXT,
        year TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    console.log("✅ Created document_chunks table");
    
    console.log("\n📦 Creating embedding_jobs table...\n");
    await db.execute(sql`
      CREATE TABLE embedding_jobs (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        document_version_id VARCHAR NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        chunk_count INTEGER,
        error_message TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `);
    console.log("✅ Created embedding_jobs table");
    
    console.log("\n📑 Creating indexes...\n");
    
    await db.execute(sql`
      CREATE INDEX document_chunks_embedding_idx 
      ON document_chunks 
      USING hnsw (embedding vector_cosine_ops)
    `);
    console.log("✅ Created HNSW index on embeddings");
    
    await db.execute(sql`CREATE INDEX document_chunks_town_idx ON document_chunks (town)`);
    console.log("✅ Created index on town");
    
    await db.execute(sql`CREATE INDEX document_chunks_category_idx ON document_chunks (category)`);
    console.log("✅ Created index on category");
    
    await db.execute(sql`CREATE INDEX document_chunks_document_version_idx ON document_chunks (document_version_id)`);
    console.log("✅ Created index on document_version_id");
    
    await db.execute(sql`CREATE INDEX embedding_jobs_status_idx ON embedding_jobs (status)`);
    console.log("✅ Created index on status");
    
    await db.execute(sql`CREATE INDEX embedding_jobs_document_version_idx ON embedding_jobs (document_version_id)`);
    console.log("✅ Created index on embedding_jobs.document_version_id");
    
    console.log("\n🎉 pgvector tables created successfully!");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

resetTables();
