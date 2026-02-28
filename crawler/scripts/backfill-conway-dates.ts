#!/usr/bin/env tsx
import { db } from "../../server/storage/db";
import { sql, eq } from "drizzle-orm";
import * as schema from "../../shared/schema";

const MONTHS: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

function extractDateFromConwayTitle(title: string): Date | null {
  const m1 = title.match(/\d+_(?:pb|zba|cc|bos|hdc)_(\w+)_(\d{1,2})_(\d{4})/i);
  if (m1) {
    const month = MONTHS[m1[1].toLowerCase()];
    if (month) {
      const d = new Date(`${m1[3]}-${month}-${m1[2].padStart(2, "0")}`);
      if (!isNaN(d.getTime())) return d;
    }
  }

  const m2 = title.match(/(\d{4})(\d{2})(\d{2})_Adopted/i);
  if (m2) {
    const d = new Date(`${m2[1]}-${m2[2]}-${m2[3]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2030) return d;
  }

  const m3 = title.match(/(\w+)_(\d{1,2})_(\d{4})\.pdf/i);
  if (m3) {
    const month = MONTHS[m3[1].toLowerCase()];
    if (month) {
      const d = new Date(`${m3[3]}-${month}-${m3[2].padStart(2, "0")}`);
      if (!isNaN(d.getTime())) return d;
    }
  }

  const m4 = title.match(/(\d{1,2})_(\d{1,2})_(\d{4})/);
  if (m4) {
    const d = new Date(`${m4[3]}-${m4[1].padStart(2, "0")}-${m4[2].padStart(2, "0")}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2030) return d;
  }

  const m5 = title.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m5) {
    const d = new Date(`${m5[1]}-${m5[2]}-${m5[3]}`);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

function extractDateFromOcrText(text: string): Date | null {
  const first500 = text.substring(0, 500);
  const m = first500.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month) {
      const d = new Date(`${m[3]}-${month}-${m[2].padStart(2, "0")}`);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log("=".repeat(70));
  console.log("Conway Meeting Date Backfill");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("=".repeat(70));

  const rows = await db.execute(sql`
    SELECT 
      dv.id as version_id,
      ld.canonical_title,
      ld.board,
      dv.meeting_date,
      left(COALESCE(fb.ocr_text, fb.preview_text, ''), 500) as ocr_text
    FROM document_versions dv
    JOIN logical_documents ld ON dv.document_id = ld.id
    LEFT JOIN file_blobs fb ON fb.id = dv.file_blob_id
    WHERE LOWER(ld.town) = 'conway'
      AND dv.meeting_date IS NULL
    ORDER BY ld.board, ld.canonical_title
  `);

  const docs = rows.rows as any[];
  console.log(`\nFound ${docs.length} Conway doc versions without meeting_date\n`);

  let updated = 0;
  let failed = 0;
  const boardStats: Record<string, { total: number; dated: number }> = {};

  for (const doc of docs) {
    const board = doc.board || "Unknown";
    if (!boardStats[board]) boardStats[board] = { total: 0, dated: 0 };
    boardStats[board].total++;

    let meetingDate = extractDateFromConwayTitle(doc.canonical_title);

    if (!meetingDate && doc.ocr_text) {
      meetingDate = extractDateFromOcrText(doc.ocr_text);
    }

    if (meetingDate) {
      boardStats[board].dated++;
      if (!DRY_RUN) {
        try {
          await db
            .update(schema.documentVersions)
            .set({ meetingDate })
            .where(eq(schema.documentVersions.id, doc.version_id));
          updated++;
        } catch (e: any) {
          console.error(`  Error updating ${doc.version_id}: ${e.message?.substring(0, 100)}`);
          failed++;
        }
      } else {
        updated++;
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(`RESULTS: ${updated} dated, ${failed} errors, ${docs.length - updated - failed} unresolved`);
  console.log("=".repeat(70));
  console.log("\nPer-board breakdown:");
  for (const [board, stats] of Object.entries(boardStats).sort((a, b) => b[1].total - a[1].total)) {
    const pct = stats.total > 0 ? Math.round((stats.dated / stats.total) * 100) : 0;
    console.log(`  ${board}: ${stats.dated}/${stats.total} dated (${pct}%)`);
  }

  if (!DRY_RUN) {
    const verification = await db.execute(sql`
      SELECT ld.board,
        COUNT(*) as total,
        SUM(CASE WHEN dv.meeting_date IS NOT NULL THEN 1 ELSE 0 END) as with_date,
        MIN(dv.meeting_date) as earliest,
        MAX(dv.meeting_date) as latest
      FROM document_versions dv
      JOIN logical_documents ld ON dv.document_id = ld.id
      WHERE LOWER(ld.town) = 'conway'
      GROUP BY ld.board
      ORDER BY total DESC
    `);
    console.log("\n\nVerification — date coverage per board:");
    for (const r of verification.rows as any[]) {
      console.log(`  ${r.board || "(no board)"}: ${r.with_date}/${r.total} with dates (${r.earliest || "none"} to ${r.latest || "none"})`);
    }
  }

  console.log("\n\nDuplicate version cleanup...");
  const dupes = await db.execute(sql`
    SELECT dv.document_id, dv.file_blob_id, COUNT(*) as cnt, 
           array_agg(dv.id ORDER BY dv.created_at DESC) as version_ids
    FROM document_versions dv
    JOIN logical_documents ld ON dv.document_id = ld.id
    WHERE LOWER(ld.town) = 'conway'
    GROUP BY dv.document_id, dv.file_blob_id
    HAVING COUNT(*) > 1
  `);
  const dupeRows = dupes.rows as any[];
  console.log(`Found ${dupeRows.length} duplicate version groups`);

  if (dupeRows.length > 0 && !DRY_RUN) {
    let removed = 0;
    for (const dupe of dupeRows) {
      const idsToRemove = dupe.version_ids.slice(1);
      for (const id of idsToRemove) {
        await db.delete(schema.documentVersions).where(eq(schema.documentVersions.id, id));
        removed++;
      }
    }
    console.log(`Removed ${removed} duplicate document_versions`);
  } else if (dupeRows.length > 0) {
    const totalDupes = dupeRows.reduce((sum: number, d: any) => sum + d.cnt - 1, 0);
    console.log(`Would remove ${totalDupes} duplicate versions (dry run)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
