#!/usr/bin/env tsx
import { db } from "../../server/storage/db";
import { sql } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 10000;

async function main() {
  console.log("=".repeat(70));
  console.log("Backfill document_chunks.document_id from file_blob linkage");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("=".repeat(70));

  const before = await db.execute(sql`
    SELECT 
      COALESCE(metadata->>'town', '(no town)') as town,
      COUNT(*) as total_chunks,
      SUM(CASE WHEN document_id IS NOT NULL AND document_id != '' THEN 1 ELSE 0 END) as linked
    FROM document_chunks
    GROUP BY 1
    ORDER BY total_chunks DESC
  `);
  console.log("\nBEFORE — linkage by town:");
  for (const r of before.rows as any[]) {
    const pct = r.total_chunks > 0 ? Math.round((r.linked / r.total_chunks) * 100) : 0;
    console.log(`  ${r.town}: ${r.linked}/${r.total_chunks} linked (${pct}%)`);
  }

  if (!DRY_RUN) {
    console.log("\nStep 1: Drop stale FK constraint (→ old documents table)...");
    try {
      await db.execute(sql`ALTER TABLE document_chunks DROP CONSTRAINT IF EXISTS document_chunks_document_id_fkey`);
      console.log("  Dropped old FK");
    } catch (e: any) {
      console.log(`  ${e.message?.substring(0, 100)}`);
    }

    console.log("\nStep 2: Clear stale document_id values (referencing old documents table)...");
    const staleResult = await db.execute(sql`
      UPDATE document_chunks
      SET document_id = NULL
      WHERE document_id IS NOT NULL
        AND document_id != ''
        AND NOT EXISTS (SELECT 1 FROM logical_documents ld WHERE ld.id = document_chunks.document_id)
    `);
    console.log(`  Cleared ${(staleResult as any).rowCount || 0} stale references`);
  }

  const linkable = await db.execute(sql`
    SELECT COUNT(*) as cnt
    FROM document_chunks dc
    JOIN document_versions dv ON dv.file_blob_id = dc.file_blob_id
    WHERE (dc.document_id IS NULL OR dc.document_id = '')
      AND dc.file_blob_id IS NOT NULL
      AND dv.document_id IS NOT NULL
  `);
  const linkableCount = (linkable.rows as any[])[0]?.cnt || 0;
  console.log(`\nChunks that can be linked via file_blob_id → document_versions: ${linkableCount}`);

  if (!DRY_RUN && linkableCount > 0) {
    console.log("\nStep 3: Dropping unique constraint on (document_id, chunk_index) temporarily...");
    try {
      await db.execute(sql`ALTER TABLE document_chunks DROP CONSTRAINT IF EXISTS document_chunks_document_id_chunk_index_key`);
      console.log("  Dropped unique constraint");
    } catch (e: any) {
      console.log(`  ${e.message?.substring(0, 100)}`);
    }

    console.log("\nStep 4: Backfilling document_id...");
    let totalUpdated = 0;
    let batch = 0;

    while (true) {
      batch++;
      const result = await db.execute(sql`
        WITH to_update AS (
          SELECT DISTINCT ON (dc.id) dc.id as chunk_id, dv.document_id
          FROM document_chunks dc
          JOIN document_versions dv ON dv.file_blob_id = dc.file_blob_id
          WHERE (dc.document_id IS NULL OR dc.document_id = '')
            AND dc.file_blob_id IS NOT NULL
            AND dv.document_id IS NOT NULL
          LIMIT ${BATCH_SIZE}
        )
        UPDATE document_chunks dc
        SET document_id = tu.document_id
        FROM to_update tu
        WHERE dc.id = tu.chunk_id
      `);

      const updated = (result as any).rowCount || 0;
      totalUpdated += updated;
      
      if (batch % 10 === 0 || updated < BATCH_SIZE) {
        console.log(`  Batch ${batch}: updated ${updated} chunks (total: ${totalUpdated})`);
      }

      if (updated < BATCH_SIZE) break;
    }

    console.log(`\nTotal updated: ${totalUpdated} chunks across ${batch} batches`);

    console.log("\nStep 5: Adding FK constraint (→ logical_documents)...");
    try {
      await db.execute(sql`
        ALTER TABLE document_chunks 
        ADD CONSTRAINT document_chunks_document_id_logical_fkey 
        FOREIGN KEY (document_id) REFERENCES logical_documents(id)
      `);
      console.log("  Created new FK (→ logical_documents)");
    } catch (e: any) {
      if (e.message?.includes("already exists")) {
        console.log("  New FK already exists");
      } else {
        console.log(`  Warning: ${e.message?.substring(0, 150)}`);
      }
    }
  }

  const nullBlob = await db.execute(sql`
    SELECT COUNT(*) as cnt
    FROM document_chunks
    WHERE (document_id IS NULL OR document_id = '')
      AND (file_blob_id IS NULL OR file_blob_id = '')
  `);
  const nullBlobCount = (nullBlob.rows as any[])[0]?.cnt || 0;

  const noVersion = await db.execute(sql`
    SELECT COUNT(*) as cnt
    FROM document_chunks dc
    LEFT JOIN document_versions dv ON dv.file_blob_id = dc.file_blob_id
    WHERE (dc.document_id IS NULL OR dc.document_id = '')
      AND dc.file_blob_id IS NOT NULL
      AND dv.id IS NULL
  `);
  const noVersionCount = (noVersion.rows as any[])[0]?.cnt || 0;

  console.log(`\nUnlinkable chunks:`);
  console.log(`  No file_blob_id at all: ${nullBlobCount}`);
  console.log(`  file_blob_id has no matching document_version: ${noVersionCount}`);

  console.log("\n" + "=".repeat(70));
  console.log("AFTER — linkage by town:");
  const after = await db.execute(sql`
    SELECT 
      COALESCE(metadata->>'town', '(no town)') as town,
      COUNT(*) as total_chunks,
      SUM(CASE WHEN document_id IS NOT NULL AND document_id != '' THEN 1 ELSE 0 END) as linked
    FROM document_chunks
    GROUP BY 1
    ORDER BY total_chunks DESC
  `);
  for (const r of after.rows as any[]) {
    const pct = r.total_chunks > 0 ? Math.round((r.linked / r.total_chunks) * 100) : 0;
    console.log(`  ${r.town}: ${r.linked}/${r.total_chunks} linked (${pct}%)`);
  }
  console.log("=".repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
