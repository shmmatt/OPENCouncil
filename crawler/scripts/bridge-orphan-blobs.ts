#!/usr/bin/env tsx
import { db } from "../../server/storage/db";
import { sql } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log("=".repeat(70));
  console.log("Bridge orphan file_blobs to logical_documents via document_versions");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("=".repeat(70));

  const orphanCount = await db.execute(sql`
    WITH orphan_blobs AS (
      SELECT DISTINCT dc.file_blob_id
      FROM document_chunks dc
      LEFT JOIN document_versions dv ON dv.file_blob_id = dc.file_blob_id
      WHERE (dc.document_id IS NULL OR dc.document_id = '')
        AND dc.file_blob_id IS NOT NULL
        AND dv.id IS NULL
    )
    SELECT COUNT(*) as cnt FROM orphan_blobs
  `);
  console.log(`\nOrphan blobs to process: ${(orphanCount.rows as any[])[0]?.cnt}`);

  if (DRY_RUN) {
    console.log("Dry run — no changes made");
  } else {
    console.log("\nStep 1: Bulk create logical_documents + document_versions for all orphans...");
    
    const result = await db.execute(sql`
      WITH orphan_blobs AS (
        SELECT DISTINCT ON (dc.file_blob_id) dc.file_blob_id,
          cd.filename,
          ct.name as town_name,
          cd.board,
          cd.category
        FROM document_chunks dc
        LEFT JOIN document_versions dv ON dv.file_blob_id = dc.file_blob_id
        JOIN crawler_documents cd ON cd.file_blob_id = dc.file_blob_id
        JOIN crawler_towns ct ON ct.id = cd.town_id
        WHERE (dc.document_id IS NULL OR dc.document_id = '')
          AND dc.file_blob_id IS NOT NULL
          AND dv.id IS NULL
      ),
      new_logical_docs AS (
        INSERT INTO logical_documents (id, town, board, canonical_title, category)
        SELECT 
          gen_random_uuid(),
          ob.town_name,
          COALESCE(ob.board, 'Unknown'),
          '[' || ob.town_name || ' - ' || REPLACE(COALESCE(ob.board, 'Unknown'), ' ', '_') || '] ' || COALESCE(ob.filename, 'unknown'),
          COALESCE(ob.category, 'document')
        FROM orphan_blobs ob
        RETURNING id, canonical_title
      ),
      matched_pairs AS (
        SELECT nld.id as logical_doc_id, ob.file_blob_id
        FROM new_logical_docs nld
        JOIN orphan_blobs ob ON 
          nld.canonical_title = '[' || ob.town_name || ' - ' || REPLACE(COALESCE(ob.board, 'Unknown'), ' ', '_') || '] ' || COALESCE(ob.filename, 'unknown')
      )
      INSERT INTO document_versions (id, document_id, file_blob_id)
      SELECT gen_random_uuid(), mp.logical_doc_id, mp.file_blob_id
      FROM matched_pairs mp
    `);
    console.log(`  Created: ${(result as any).rowCount || 0} document_versions`);

    console.log("\nStep 2: Re-linking chunks to logical_documents...");
    let totalLinked = 0;
    while (true) {
      const linkResult = await db.execute(sql`
        WITH to_update AS (
          SELECT DISTINCT ON (dc.id) dc.id as chunk_id, dv.document_id
          FROM document_chunks dc
          JOIN document_versions dv ON dv.file_blob_id = dc.file_blob_id
          WHERE (dc.document_id IS NULL OR dc.document_id = '')
            AND dc.file_blob_id IS NOT NULL
            AND dv.document_id IS NOT NULL
          LIMIT 10000
        )
        UPDATE document_chunks dc
        SET document_id = tu.document_id
        FROM to_update tu
        WHERE dc.id = tu.chunk_id
      `);
      const updated = (linkResult as any).rowCount || 0;
      totalLinked += updated;
      console.log(`  Linked ${updated} chunks (total: ${totalLinked})`);
      if (updated < 10000) break;
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("FINAL — linkage by town:");
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
