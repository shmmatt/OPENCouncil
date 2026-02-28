#!/usr/bin/env tsx
import { db } from "../../server/storage/db";
import { sql } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");

const AGENCY_MAP: Record<string, string> = {
  "nh-dra": "NH Dept of Revenue Administration",
  "nh-osi": "NH Office of Strategic Initiatives",
  "nh-muni-assoc": "NH Municipal Association",
  "nh-des": "NH Dept of Environmental Services",
  "nh-rsas": "NH Revised Statutes Annotated",
  "nh-admin-rules": "NH Administrative Rules",
  "nh-supreme-court": "NH Supreme Court",
  "nh-dot": "NH Dept of Transportation",
  "nh-oep": "NH Office of Energy and Planning",
  "nh-sec-state": "NH Secretary of State",
};

function deriveAgency(s3Key: string | null): string {
  if (!s3Key) return "Unknown";
  const parts = s3Key.split("/");
  if (parts[0] === "statewide" && parts.length >= 2) {
    return AGENCY_MAP[parts[1]] || parts[1];
  }
  if (parts[0] === "state" && parts.length >= 2) {
    return AGENCY_MAP[parts[1]] || parts[1];
  }
  return "Unknown";
}

function deriveCategory(s3Key: string | null): string {
  if (!s3Key) return "document";
  const parts = s3Key.split("/");
  const subdir = parts[0] === "statewide" || parts[0] === "state" ? parts[2] : parts[1];
  if (!subdir) return "document";
  const map: Record<string, string> = {
    rsas: "ordinances",
    regulations: "ordinances",
    administrative_rules: "ordinances",
    guidance: "reports",
    manuals: "reports",
    forms: "permits",
    bulletins: "reports",
    model_documents: "reports",
    opinions: "reports",
    budgetary: "financials",
  };
  return map[subdir] || "document";
}

async function main() {
  console.log("=".repeat(70));
  console.log("Bridge statewide + unknown orphan blobs");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("=".repeat(70));

  const orphans = await db.execute(sql`
    SELECT DISTINCT dc.file_blob_id, fb.s3_key, fb.original_filename
    FROM document_chunks dc
    JOIN file_blobs fb ON fb.id = dc.file_blob_id
    LEFT JOIN document_versions dv ON dv.file_blob_id = dc.file_blob_id
    WHERE dc.metadata->>'town' IN ('statewide', 'unknown')
      AND (dc.document_id IS NULL OR dc.document_id = '')
      AND dv.id IS NULL
  `);

  const rows = orphans.rows as any[];
  console.log(`\nOrphan blobs: ${rows.length}`);

  const agencyStats: Record<string, number> = {};
  for (const r of rows) {
    const agency = deriveAgency(r.s3_key);
    agencyStats[agency] = (agencyStats[agency] || 0) + 1;
  }
  console.log("\nAgency breakdown:");
  for (const [agency, count] of Object.entries(agencyStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${agency}: ${count} blobs`);
  }

  if (DRY_RUN) {
    console.log("\nDry run — no changes made");
    return;
  }

  console.log("\nStep 1: Creating logical_documents + document_versions...");
  let created = 0;
  let errors = 0;

  for (const r of rows) {
    try {
      const agency = deriveAgency(r.s3_key);
      const category = deriveCategory(r.s3_key);
      const filename = r.original_filename || "unknown";
      const canonicalTitle = `[statewide - ${agency.replace(/ /g, '_')}] ${filename}`;

      await db.execute(sql`
        WITH new_doc AS (
          INSERT INTO logical_documents (id, town, board, canonical_title, category)
          VALUES (gen_random_uuid(), 'statewide', ${agency}, ${canonicalTitle}, ${category})
          RETURNING id
        )
        INSERT INTO document_versions (id, document_id, file_blob_id)
        SELECT gen_random_uuid(), new_doc.id, ${r.file_blob_id}
        FROM new_doc
      `);
      created++;
    } catch (e: any) {
      errors++;
      if (errors <= 3) console.error(`  Error: ${e.message?.substring(0, 120)}`);
    }
  }
  console.log(`  Created ${created} logical_documents + document_versions (${errors} errors)`);

  console.log("\nStep 2: Re-linking chunks...");
  let totalLinked = 0;
  while (true) {
    const result = await db.execute(sql`
      WITH to_update AS (
        SELECT DISTINCT ON (dc.id) dc.id as chunk_id, dv.document_id
        FROM document_chunks dc
        JOIN document_versions dv ON dv.file_blob_id = dc.file_blob_id
        WHERE (dc.document_id IS NULL OR dc.document_id = '')
          AND dc.file_blob_id IS NOT NULL
          AND dv.document_id IS NOT NULL
          AND dc.metadata->>'town' IN ('statewide', 'unknown')
        LIMIT 10000
      )
      UPDATE document_chunks dc
      SET document_id = tu.document_id
      FROM to_update tu
      WHERE dc.id = tu.chunk_id
    `);
    const updated = (result as any).rowCount || 0;
    totalLinked += updated;
    console.log(`  Linked ${updated} chunks (total: ${totalLinked})`);
    if (updated < 10000) break;
  }

  console.log("\n" + "=".repeat(70));
  console.log("FINAL — linkage for statewide + unknown:");
  const after = await db.execute(sql`
    SELECT 
      metadata->>'town' as town,
      COUNT(*) as total_chunks,
      SUM(CASE WHEN document_id IS NOT NULL AND document_id != '' THEN 1 ELSE 0 END) as linked
    FROM document_chunks
    WHERE metadata->>'town' IN ('statewide', 'unknown')
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
