#!/usr/bin/env tsx
import { db } from "../../server/storage/db";
import { sql, eq, and } from "drizzle-orm";
import * as schema from "../../shared/schema";

const BOARD_MAP: Record<string, string> = {
  Planning_Board: "Planning Board",
  Zoning_Board: "Zoning Board of Adjustment",
  Zoning_Board_of_Adjustment: "Zoning Board of Adjustment",
  Board_of_Selectmen: "Board of Selectmen",
  Select_Board: "Board of Selectmen",
  Budget_Committee: "Budget Committee",
  Conservation_Commission: "Conservation Commission",
  School_Board: "School Board",
  Historic_District_Commission: "Historic District Commission",
  Library_Trustees: "Library Trustees",
  Parks_and_Recreation: "Parks and Recreation",
  Emergency_Services_Advisory_Committee: "Emergency Services Advisory Committee",
  Community_Power_Committee: "Community Power Committee",
  Skate_Park_Committee: "Skate Park Committee",
  Lower_MWV_Solid_Waste_District: "Lower MWV Solid Waste District",
};

const FILENAME_BOARD_PATTERNS: Array<[RegExp, string]> = [
  [/\bAPB[-_]/i, "Planning Board"],
  [/\bPB[-_]/i, "Planning Board"],
  [/\bABS[-_]/i, "Board of Selectmen"],
  [/\bBOS[-_]/i, "Board of Selectmen"],
  [/\bSelectmen[-_]/i, "Board of Selectmen"],
  [/\bZBA[-_]/i, "Zoning Board of Adjustment"],
  [/\bECC[-_]/i, "Conservation Commission"],
  [/\bCC[-_]/i, "Conservation Commission"],
  [/\bbpb[-_]/i, "Planning Board"],
];

const OCR_BOARD_PATTERNS: Array<[RegExp, string]> = [
  [/Planning\s+Board/i, "Planning Board"],
  [/Zoning\s+Board/i, "Zoning Board of Adjustment"],
  [/Office\s+of\s+Select/i, "Board of Selectmen"],
  [/Board\s+of\s+Select/i, "Board of Selectmen"],
  [/Select\s*Board/i, "Board of Selectmen"],
  [/Budget\s+Committee/i, "Budget Committee"],
  [/Conservation\s+Commission/i, "Conservation Commission"],
  [/School\s+Board/i, "School Board"],
  [/Historic\s+District/i, "Historic District Commission"],
  [/Library\s+Trustee/i, "Library Trustees"],
  [/Parks\s+and\s+Recreation/i, "Parks and Recreation"],
];

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

function extractDateFromFilename(filename: string): Date | null {
  const m1 = filename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (m1) {
    const d = new Date(`${m1[1]}-${m1[2]}-${m1[3]}`);
    if (!isNaN(d.getTime())) return d;
  }

  const m2 = filename.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})/);
  if (m2) {
    const y = m2[3].length === 4 ? m2[3] : parseInt(m2[3], 10) > 50 ? `19${m2[3]}` : `20${m2[3]}`;
    const d = new Date(`${y}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2030) return d;
  }

  const m3 = filename.match(/(\d{2})(\d{2})(\d{4})/);
  if (m3) {
    const d = new Date(`${m3[3]}-${m3[1]}-${m3[2]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2030) return d;
  }

  return null;
}

function extractDateFromOcrText(text: string): Date | null {
  const first500 = text.substring(0, 500);
  const m = first500.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    const d = new Date(`${m[3]}-${month}-${m[2].padStart(2, "0")}`);
    if (!isNaN(d.getTime())) return d;
  }

  const m2 = first500.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m2) {
    const d = new Date(`${m2[3]}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2030) return d;
  }

  return null;
}

function extractYearFromFilename(filename: string): string | null {
  const d = extractDateFromFilename(filename);
  if (d && !isNaN(d.getTime())) return String(d.getFullYear());
  const m = filename.match(/\b(20\d{2}|19\d{2})\b/);
  return m ? m[1] : null;
}

function normalizeBoardName(raw: string): string {
  if (BOARD_MAP[raw]) return BOARD_MAP[raw];
  return raw.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function extractBoardFromPath(s3Key: string): string | null {
  const parts = s3Key.split("/");
  for (const part of parts) {
    if (BOARD_MAP[part]) return BOARD_MAP[part];
  }
  return null;
}

function extractBoardFromFilename(filename: string): string | null {
  for (const [pattern, board] of FILENAME_BOARD_PATTERNS) {
    if (pattern.test(filename)) return board;
  }
  return null;
}

function extractBoardFromOcr(ocrText: string): string | null {
  const first500 = ocrText.substring(0, 500);
  for (const [pattern, board] of OCR_BOARD_PATTERNS) {
    if (pattern.test(first500)) return board;
  }
  return null;
}

function resolveBoard(crawlerBoard: string | null, s3Key: string, filename: string, ocrText: string): string {
  if (crawlerBoard && crawlerBoard.trim()) {
    return normalizeBoardName(crawlerBoard);
  }
  return extractBoardFromPath(s3Key)
    || extractBoardFromFilename(filename)
    || extractBoardFromOcr(ocrText)
    || "Unknown Board";
}

function normalizeTownName(raw: string): string {
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

interface GappedDoc {
  crawler_doc_id: string;
  town_name: string;
  board: string | null;
  s3_key: string;
  filename: string;
  file_blob_id: string;
  ocr_text: string;
}

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_LIMIT = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "0", 10) || 99999;
const TOWN_FILTER = process.argv.find(a => a.startsWith("--town="))?.split("=")[1] || null;

async function linkDocument(doc: GappedDoc): Promise<{ status: "ok" | "error"; board: string; hasDate: boolean }> {
  const board = resolveBoard(doc.board, doc.s3_key, doc.filename, doc.ocr_text);
  const town = normalizeTownName(doc.town_name);
  const meetingDate = extractDateFromFilename(doc.filename) || extractDateFromOcrText(doc.ocr_text);
  const year = extractYearFromFilename(doc.filename)
    || (meetingDate ? String(meetingDate.getFullYear()) : null)
    || doc.s3_key.match(/\b(20\d{2}|19\d{2})\b/)?.[1]
    || null;
  const canonicalTitle = doc.filename;

  if (DRY_RUN) {
    return { status: "ok", board, hasDate: !!meetingDate };
  }

  try {
    let logicalDoc = await db.query.logicalDocuments.findFirst({
      where: and(
        eq(schema.logicalDocuments.canonicalTitle, canonicalTitle),
        eq(schema.logicalDocuments.town, town)
      ),
    });

    if (!logicalDoc) {
      [logicalDoc] = await db
        .insert(schema.logicalDocuments)
        .values({
          canonicalTitle,
          town,
          category: "meeting_minutes",
          board,
        })
        .returning();
    }

    const existingVersion = await db.execute(sql`
      SELECT id FROM document_versions 
      WHERE document_id = ${logicalDoc.id} AND file_blob_id = ${doc.file_blob_id}
      LIMIT 1
    `);

    if (existingVersion.rows.length > 0) {
      return { status: "ok", board, hasDate: !!meetingDate };
    }

    const [version] = await db
      .insert(schema.documentVersions)
      .values({
        documentId: logicalDoc.id,
        fileBlobId: doc.file_blob_id,
        year,
        isCurrent: true,
        isMinutes: true,
        meetingDate,
      })
      .returning();

    await db
      .update(schema.logicalDocuments)
      .set({ currentVersionId: version.id })
      .where(eq(schema.logicalDocuments.id, logicalDoc.id));

    return { status: "ok", board, hasDate: !!meetingDate };
  } catch (e: any) {
    console.error(`  Error linking ${town}/${doc.filename}: ${e.message?.substring(0, 120)}`);
    return { status: "error", board, hasDate: false };
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("Backfill: Link all gapped crawler_documents → logical_documents");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}, Limit: ${BATCH_LIMIT}${TOWN_FILTER ? `, Town: ${TOWN_FILTER}` : ""}`);
  console.log("=".repeat(70));

  const townFilter = TOWN_FILTER ? sql`AND lower(ct.name) = ${TOWN_FILTER.toLowerCase()}` : sql``;

  const rows = await db.execute(sql`
    SELECT 
      cd.id as crawler_doc_id,
      ct.name as town_name,
      cd.board,
      cd.s3_key,
      cd.filename,
      fb.id as file_blob_id,
      left(COALESCE(fb.ocr_text, fb.preview_text, ''), 500) as ocr_text
    FROM crawler_documents cd
    JOIN crawler_towns ct ON cd.town_id = ct.id
    JOIN file_blobs fb ON fb.raw_hash = 's3:' || cd.s3_key
    WHERE cd.status = 'uploaded'
      AND cd.category = 'minutes'
      AND COALESCE(fb.ocr_text, fb.preview_text) IS NOT NULL
      AND length(COALESCE(fb.ocr_text, fb.preview_text, '')) > 200
      AND NOT EXISTS (
        SELECT 1 FROM document_versions dv WHERE dv.file_blob_id = fb.id
      )
      ${townFilter}
    ORDER BY ct.name, cd.board, cd.s3_key
    LIMIT ${BATCH_LIMIT}
  `);

  const docs = rows.rows as unknown as GappedDoc[];
  console.log(`\nFound ${docs.length} gapped documents to link\n`);

  if (docs.length === 0) {
    console.log("Nothing to do!");
    process.exit(0);
  }

  const townStats: Record<string, { ok: number; error: number; boards: Record<string, number>; datesExtracted: number }> = {};
  let totalOk = 0, totalError = 0, totalDates = 0;
  const startTime = Date.now();

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const result = await linkDocument(doc);
    const town = normalizeTownName(doc.town_name);

    if (!townStats[town]) {
      townStats[town] = { ok: 0, error: 0, boards: {}, datesExtracted: 0 };
    }

    if (result.status === "ok") {
      totalOk++;
      townStats[town].ok++;
      townStats[town].boards[result.board] = (townStats[town].boards[result.board] || 0) + 1;
      if (result.hasDate) {
        totalDates++;
        townStats[town].datesExtracted++;
      }
    } else {
      totalError++;
      townStats[town].error++;
    }

    if ((i + 1) % 50 === 0 || i === docs.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = ((i + 1) / ((Date.now() - startTime) / 1000)).toFixed(1);
      process.stdout.write(
        `\r[${elapsed}s] ${i + 1}/${docs.length} (${totalOk} ok, ${totalError} err, ${totalDates} dates) @ ${rate}/s`
      );
    }
  }

  console.log("\n\n" + "=".repeat(70));
  console.log(`RESULTS: ${totalOk} linked, ${totalError} errors, ${totalDates} dates extracted`);
  console.log("=".repeat(70));

  console.log("\nPer-town breakdown:");
  for (const [town, stats] of Object.entries(townStats).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`\n  ${town}: ${stats.ok} linked, ${stats.error} errors, ${stats.datesExtracted} dates`);
    for (const [board, count] of Object.entries(stats.boards).sort((a, b) => b[1] - a[1])) {
      console.log(`    - ${board}: ${count}`);
    }
  }

  if (!DRY_RUN) {
    const verification = await db.execute(sql`
      SELECT ct.name as town, COUNT(DISTINCT dv.id) as linked
      FROM crawler_documents cd
      JOIN crawler_towns ct ON cd.town_id = ct.id
      JOIN file_blobs fb ON fb.raw_hash = 's3:' || cd.s3_key
      JOIN document_versions dv ON dv.file_blob_id = fb.id
      WHERE cd.status = 'uploaded' AND cd.category = 'minutes'
      GROUP BY ct.name
      ORDER BY ct.name
    `);
    console.log("\n\nVerification — total linked docs per town:");
    for (const r of verification.rows as any[]) {
      console.log(`  ${r.town}: ${r.linked}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
