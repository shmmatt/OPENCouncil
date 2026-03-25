#!/usr/bin/env tsx
/**
 * Backfill meeting dates (and improve board names) for all meeting_minutes
 * logical_documents that have meeting_date IS NULL across all towns.
 *
 * Tiered approach:
 *   Tier 1 — filename/title regex (richer pattern set, no I/O cost)
 *   Tier 2 — OCR / preview-text heuristics (month-name regex + MM/DD/YYYY)
 *   Tier 3 — Gemini LLM via suggestMetadataFromPreview (last resort)
 *
 * Flags:
 *   --dry-run        Print what would change without writing to DB
 *   --town=<name>    Restrict to a specific town (case-insensitive)
 *   --skip-llm       Only run tiers 1 and 2; skip Gemini LLM calls
 *   --limit=<n>      Cap how many documents to process
 *   --improve-boards Also call LLM for docs where the date was found heuristically
 *                    but the board name is still weak — fixes board without waiting
 *                    for a separate classify-unknown-boards run
 */
import "dotenv/config";
import { db } from "../../server/storage/db";
import { sql, eq } from "drizzle-orm";
import * as schema from "../../shared/schema";
import { suggestMetadataFromPreview, parseDateToISO } from "../../server/services/metadataExtraction";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_LLM = process.argv.includes("--skip-llm");
const IMPROVE_BOARDS = process.argv.includes("--improve-boards");
const TOWN_FILTER = process.argv.find(a => a.startsWith("--town="))?.split("=")[1]?.toLowerCase() || null;
const BATCH_LIMIT = parseInt(
  process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "0",
  10
) || 999_999;

// ---------------------------------------------------------------------------
// Month name lookup used by multiple tiers
// ---------------------------------------------------------------------------
const MONTHS: Record<string, string> = {
  january: "01", jan: "01",
  february: "02", feb: "02",
  march: "03", mar: "03",
  april: "04", apr: "04",
  may: "05",
  june: "06", jun: "06",
  july: "07", jul: "07",
  august: "08", aug: "08",
  september: "09", sep: "09", sept: "09",
  october: "10", oct: "10",
  november: "11", nov: "11",
  december: "12", dec: "12",
};

// ---------------------------------------------------------------------------
// Tier 1 — filename / title regex (richer, multi-pattern set)
// ---------------------------------------------------------------------------
function extractDateFromTitle(title: string): Date | null {
  // Pattern: YYYY-MM-DD or YYYY_MM_DD anywhere in title
  const m1 = title.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (m1) {
    const d = new Date(`${m1[1]}-${m1[2]}-${m1[3]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
  }

  // Pattern: something like "20231115_Adopted" (YYYYMMDD fused)
  const m1b = title.match(/(\d{4})(\d{2})(\d{2})(?:_|\.|-)/);
  if (m1b) {
    const d = new Date(`${m1b[1]}-${m1b[2]}-${m1b[3]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
  }

  // Pattern: board abbreviation prefix — e.g. "12_pb_march_5_2024.pdf"
  const m2 = title.match(/\d+_(?:pb|zba|cc|bos|hdc|sb|bc)_(\w+)_(\d{1,2})_(\d{4})/i);
  if (m2) {
    const month = MONTHS[m2[1].toLowerCase()];
    if (month) {
      const d = new Date(`${m2[3]}-${month}-${m2[2].padStart(2, "0")}`);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // Pattern: "March_5_2024" or "march-5-2024" (month name + day + year)
  const m3 = title.match(/([A-Za-z]+)[-_ ](\d{1,2})[-_ ](\d{4})/);
  if (m3) {
    const month = MONTHS[m3[1].toLowerCase()];
    if (month) {
      const d = new Date(`${m3[3]}-${month}-${m3[2].padStart(2, "0")}`);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
    }
  }

  // Pattern: MM_DD_YYYY or MM-DD-YYYY (US format with separators)
  const m4 = title.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{4})/);
  if (m4) {
    const d = new Date(`${m4[3]}-${m4[1].padStart(2, "0")}-${m4[2].padStart(2, "0")}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
  }

  // Pattern: MM_DD_YY short year
  const m5 = title.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{2})(?!\d)/);
  if (m5) {
    const yy = parseInt(m5[3], 10);
    const yyyy = yy > 50 ? `19${m5[3]}` : `20${m5[3]}`;
    const d = new Date(`${yyyy}-${m5[1].padStart(2, "0")}-${m5[2].padStart(2, "0")}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
  }

  // Pattern: MMDDYYYY fused (e.g. "03052024")
  const m6 = title.match(/\b(\d{2})(\d{2})(\d{4})\b/);
  if (m6) {
    const d = new Date(`${m6[3]}-${m6[1]}-${m6[2]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tier 2 — OCR / preview-text heuristics
// ---------------------------------------------------------------------------
function extractDateFromText(text: string): Date | null {
  const first1500 = text.substring(0, 1500);

  // "March 5, 2024" or "March 5th, 2024"
  const m1 = first1500.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i
  );
  if (m1) {
    const month = MONTHS[m1[1].toLowerCase()];
    if (month) {
      const d = new Date(`${m1[3]}-${month}-${m1[2].padStart(2, "0")}`);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // MM/DD/YYYY
  const m2 = first1500.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m2) {
    const d = new Date(`${m2[3]}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
  }

  // YYYY-MM-DD ISO in text
  const m3 = first1500.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m3) {
    const d = new Date(`${m3[1]}-${m3[2]}-${m3[3]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Board name quality helpers
// ---------------------------------------------------------------------------
const WEAK_BOARD_NAMES = new Set([
  "unknown board", "unknown", "needs review", "", "uncategorized", "none"
]);

function isWeakBoard(board: string | null): boolean {
  return !board || WEAK_BOARD_NAMES.has(board.toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------
interface DocRow {
  ld_id: string;
  dv_id: string;
  town: string;
  canonical_title: string;
  board: string | null;
  text_sample: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=".repeat(70));
  console.log("Backfill: meeting_date for all-town meeting_minutes (null dates)");
  console.log(
    `Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"} | LLM: ${SKIP_LLM ? "SKIPPED" : "ENABLED"} | ` +
    `improve-boards: ${IMPROVE_BOARDS ? "YES" : "NO"} | Town: ${TOWN_FILTER || "all"} | Limit: ${BATCH_LIMIT}`
  );
  console.log("=".repeat(70));

  const townCondition = TOWN_FILTER
    ? sql`AND lower(ld.town) = ${TOWN_FILTER}`
    : sql``;

  const rows = await db.execute(sql`
    SELECT
      ld.id            AS ld_id,
      dv.id            AS dv_id,
      ld.town,
      ld.canonical_title,
      ld.board,
      left(COALESCE(fb.ocr_text, fb.preview_text, ''), 1500) AS text_sample
    FROM logical_documents ld
    JOIN document_versions dv ON ld.id = dv.document_id
    LEFT JOIN file_blobs fb   ON dv.file_blob_id = fb.id
    WHERE ld.category = 'meeting_minutes'
      AND dv.meeting_date IS NULL
      ${townCondition}
    ORDER BY ld.town, ld.canonical_title
    LIMIT ${BATCH_LIMIT}
  `);

  const docs = rows.rows as unknown as DocRow[];
  console.log(`\nFound ${docs.length} documents with null meeting_date\n`);

  if (docs.length === 0) {
    console.log("Nothing to do!");
    process.exit(0);
  }

  const stats = {
    tier1: 0,
    tier2: 0,
    tier3: 0,
    tier3_nodate: 0,
    boardUpdated: 0,
    failed: 0,
    skipped: 0,
  };

  const startTime = Date.now();
  const townStats: Record<string, { dated: number; boardFixed: number; errors: number; llm: number }> = {};

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const town = doc.town;
    if (!townStats[town]) townStats[town] = { dated: 0, boardFixed: 0, errors: 0, llm: 0 };

    let meetingDate: Date | null = null;
    let tier = 0;
    let newBoard: string | null = null;

    // ------------------------------------------------------------------
    // Tier 1: filename / title regex
    // ------------------------------------------------------------------
    meetingDate = extractDateFromTitle(doc.canonical_title);
    if (meetingDate) {
      tier = 1;
      stats.tier1++;
    }

    // ------------------------------------------------------------------
    // Tier 2: OCR / preview text heuristics
    // ------------------------------------------------------------------
    if (!meetingDate && doc.text_sample) {
      meetingDate = extractDateFromText(doc.text_sample);
      if (meetingDate) {
        tier = 2;
        stats.tier2++;
      }
    }

    // ------------------------------------------------------------------
    // Tier 3: LLM — conditions:
    //   (a) date still missing after tiers 1 & 2, OR
    //   (b) --improve-boards is set and board is still weak (even if date found)
    // ------------------------------------------------------------------
    const needsLlmForDate = !meetingDate;
    const needsLlmForBoard = IMPROVE_BOARDS && isWeakBoard(doc.board);
    if ((needsLlmForDate || needsLlmForBoard) && !SKIP_LLM) {
      try {
        const suggested = await suggestMetadataFromPreview(
          doc.canonical_title,
          doc.text_sample || "",
          { defaultTown: doc.town, defaultBoard: doc.board || undefined }
        );

        townStats[town].llm++;

        if (needsLlmForDate) {
          if (suggested.meetingDate) {
            const parsed = parseDateToISO(suggested.meetingDate);
            if (parsed) {
              meetingDate = new Date(parsed);
              if (isNaN(meetingDate.getTime())) {
                meetingDate = null;
              } else {
                tier = 3;
                stats.tier3++;
              }
            }
          } else {
            stats.tier3_nodate++;
          }
        }

        // Check if LLM gave us a better board name
        if (suggested.board && isWeakBoard(doc.board) && !isWeakBoard(suggested.board)) {
          newBoard = suggested.board;
        }
      } catch (llmErr: unknown) {
        const errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
        console.error(
          `  [LLM error] ${doc.town}/${doc.canonical_title}: ${errMsg.substring(0, 120)}`
        );
        stats.failed++;
        townStats[town].errors++;
      }
    }

    // ------------------------------------------------------------------
    // Write to DB
    // ------------------------------------------------------------------
    const logLine = [
      `[${String(i + 1).padStart(5)}/${docs.length}]`,
      `T${tier || "-"}`,
      `${doc.town}/${doc.canonical_title.substring(0, 50)}`,
      meetingDate ? `→ ${meetingDate.toISOString().split("T")[0]}` : "→ (no date)",
      newBoard ? `board→ "${newBoard}"` : "",
    ]
      .filter(Boolean)
      .join("  ");

    if (DRY_RUN) {
      if (meetingDate || newBoard) console.log(logLine);
      if (meetingDate) townStats[town].dated++;
      if (newBoard) townStats[town].boardFixed++;
      continue;
    }

    if (meetingDate) {
      const year = String(meetingDate.getFullYear());
      try {
        await db
          .update(schema.documentVersions)
          .set({ meetingDate, year })
          .where(eq(schema.documentVersions.id, doc.dv_id));
        townStats[town].dated++;
        console.log(logLine);
      } catch (dbErr: unknown) {
        const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        console.error(`  [DB error] ${doc.dv_id}: ${errMsg.substring(0, 120)}`);
        stats.failed++;
        townStats[town].errors++;
      }
    }

    if (newBoard) {
      try {
        await db
          .update(schema.logicalDocuments)
          .set({ board: newBoard })
          .where(eq(schema.logicalDocuments.id, doc.ld_id));
        stats.boardUpdated++;
        townStats[town].boardFixed++;
        if (!meetingDate) console.log(logLine); // don't double-print
      } catch (dbErr: unknown) {
        const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        console.error(`  [DB board error] ${doc.ld_id}: ${errMsg.substring(0, 120)}`);
      }
    }

    // Rate-limit LLM calls slightly
    if (!SKIP_LLM && tier === 3 && i < docs.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "=".repeat(70));
  console.log(`RESULTS (${elapsed}s):`);
  console.log(`  Tier 1 (filename regex): ${stats.tier1}`);
  console.log(`  Tier 2 (text heuristic): ${stats.tier2}`);
  console.log(`  Tier 3 (LLM dated):      ${stats.tier3}`);
  console.log(`  Tier 3 (LLM no date):    ${stats.tier3_nodate}`);
  console.log(`  Board updated:           ${stats.boardUpdated}`);
  console.log(`  Errors:                  ${stats.failed}`);
  console.log(`  Total dated:             ${stats.tier1 + stats.tier2 + stats.tier3}`);
  console.log("=".repeat(70));

  console.log("\nPer-town breakdown:");
  for (const [t, s] of Object.entries(townStats).sort((a, b) => a[0].localeCompare(b[0]))) {
    const llmNote = SKIP_LLM ? "" : ` (${s.llm} LLM calls)`;
    console.log(
      `  ${t}: ${s.dated} dated, ${s.boardFixed} boards fixed, ${s.errors} errors${llmNote}`
    );
  }

  if (!DRY_RUN) {
    const remaining = await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM document_versions dv
      JOIN logical_documents ld ON ld.id = dv.document_id
      WHERE ld.category = 'meeting_minutes' AND dv.meeting_date IS NULL
    `);
    const remainingRow = remaining.rows[0] as Record<string, unknown>;
    console.log(`\nRemaining null meeting_date docs: ${remainingRow.cnt}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("Fatal:", e);
    process.exit(1);
  });
