import { db, sql } from "../server/storage/db";

async function check() {
  const result = await db.execute(sql`
    SELECT column_name, data_type, udt_name 
    FROM information_schema.columns 
    WHERE table_name = 'document_chunks' AND column_name = 'embedding'
  `);
  console.log('Embedding column:', result.rows[0]);
  
  const indexes = await db.execute(sql`
    SELECT indexname, indexdef 
    FROM pg_indexes 
    WHERE tablename = 'document_chunks' AND indexname LIKE '%embedding%'
  `);
  console.log('\nEmbedding indexes:', indexes.rows);
  
  process.exit(0);
}

check();
