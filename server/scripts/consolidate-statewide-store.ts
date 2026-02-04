/**
 * Consolidate Statewide Documents Script
 * 
 * Creates a dedicated "statewide" File Search store containing:
 * - NH RSA statutes
 * - NHMA guidance
 * - AG opinions
 * - Other NH-wide municipal documents
 * 
 * This store will be queried alongside town stores for all queries.
 */

import { db, schema, eq, and, or, sql } from "../storage/db";
import { GoogleGenAI } from "@google/genai";

const STATEWIDE_STORE_NAME = "opencouncil-statewide";

async function main() {
  console.log("=== Statewide Store Consolidation ===\n");
  
  // Step 1: Find all documents with town="statewide" (case-insensitive)
  console.log("1. Finding statewide documents...");
  
  const statewideLogicalDocs = await db
    .select()
    .from(schema.logicalDocuments)
    .where(sql`LOWER(town) = 'statewide'`);
  
  console.log(`   Found ${statewideLogicalDocs.length} logical documents marked as statewide`);
  
  const statewideS3Docs = await db
    .select()
    .from(schema.s3GeminiSync)
    .where(and(
      sql`LOWER(town) = 'statewide'`,
      eq(schema.s3GeminiSync.status, "synced")
    ));
  
  console.log(`   Found ${statewideS3Docs.length} S3 documents marked as statewide`);
  
  // Step 2: Check if a statewide store already exists
  console.log("\n2. Checking for existing statewide store...");
  
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  const stores = await ai.files.listStores();
  
  let statewideStore = stores.fileSearchStores.find(s => 
    s.displayName?.toLowerCase().includes("statewide") ||
    s.name.includes(STATEWIDE_STORE_NAME)
  );
  
  if (statewideStore) {
    console.log(`   Found existing statewide store: ${statewideStore.name}`);
    console.log(`   Display name: ${statewideStore.displayName}`);
  } else {
    console.log("   No statewide store found - one should be created");
  }
  
  // Step 3: Identify documents that should be in statewide store
  console.log("\n3. Identifying documents for statewide store...");
  
  // Patterns that indicate statewide documents
  const statewidePatterns = [
    /rsa/i,
    /statute/i,
    /nhma/i,
    /municipal association/i,
    /attorney general/i,
    /ag opinion/i,
    /right[\s-]to[\s-]know/i,
    /statewide/i,
    /new hampshire law/i,
    /nh law/i,
  ];
  
  // Check logical_documents for potential statewide content
  const allLogicalDocs = await db
    .select({
      id: schema.logicalDocuments.id,
      title: schema.logicalDocuments.title,
      town: schema.logicalDocuments.town,
    })
    .from(schema.logicalDocuments);
  
  const potentialStatewideDocs = allLogicalDocs.filter(doc => {
    if (doc.town?.toLowerCase() === 'statewide') return true;
    const titleLower = doc.title?.toLowerCase() || "";
    return statewidePatterns.some(pattern => pattern.test(titleLower));
  });
  
  console.log(`   Identified ${potentialStatewideDocs.length} documents that should be in statewide store`);
  console.log(`   Towns represented: ${Array.from(new Set(potentialStatewideDocs.map(d => d.town))).join(", ")}`);
  
  // Step 4: Provide consolidation plan
  console.log("\n4. Consolidation Plan:");
  console.log("   =====================");
  
  if (!statewideStore) {
    console.log("   a) Create new Gemini File Search store: 'opencouncil-statewide'");
  } else {
    console.log(`   a) Use existing store: ${statewideStore.name}`);
  }
  
  console.log(`   b) Upload/move ${potentialStatewideDocs.length} documents to statewide store`);
  console.log(`   c) Update database records to reference statewide store`);
  console.log(`   d) Update all town documents to set town field = lowercase(town)`);
  
  // Step 5: Show current store distribution
  console.log("\n5. Current Store Distribution:");
  
  const storeStats = await db.execute(sql`
    SELECT 
      gemini_store_id,
      town,
      COUNT(*) as doc_count
    FROM s3_gemini_sync
    WHERE status = 'synced' AND gemini_store_id IS NOT NULL
    GROUP BY gemini_store_id, town
    ORDER BY town, doc_count DESC
  `);
  
  console.log("\n   Store ID | Town | Docs");
  console.log("   " + "-".repeat(80));
  for (const row of storeStats.rows) {
    const r = row as any;
    console.log(`   ${r.gemini_store_id?.slice(17, 45) || 'null'} | ${r.town} | ${r.doc_count}`);
  }
  
  console.log("\n=== Analysis Complete ===");
  console.log("\nNext steps:");
  console.log("1. Review the consolidation plan above");
  console.log("2. Run ingestion with town='statewide' for RSA/NHMA docs");
  console.log("3. Update existing misclassified docs to town='statewide'");
  console.log("4. Code changes are already committed (multi-store retrieval)");
}

main().catch(console.error);
