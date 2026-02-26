#!/usr/bin/env tsx
import { db } from "../../server/storage/db";
import { sql } from "drizzle-orm";

const TOWN = "Ossipee";
const TOWN_SLUG = "ossipee";

const BOARD_MAP: Record<string, string> = {
  Planning_Board: "Planning Board",
  Zoning_Board: "Zoning Board of Adjustment",
};

function extractYearFromFilename(filename: string): string | null {
  const dateMatch = filename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (dateMatch) return dateMatch[1];

  const shortDateMatch = filename.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})/);
  if (shortDateMatch) {
    const yearPart = shortDateMatch[3];
    if (yearPart.length === 4) return yearPart;
    if (yearPart.length === 2) {
      const y = parseInt(yearPart, 10);
      return y > 50 ? `19${yearPart}` : `20${yearPart}`;
    }
  }

  const looseYear = filename.match(/\b(20\d{2}|19\d{2})\b/);
  if (looseYear) return looseYear[1];

  return null;
}

async function bridge() {
  console.log("=".repeat(60));
  console.log(`Bridging ${TOWN} PB/ZBA minutes from crawler_documents → s3_gemini_sync`);
  console.log("=".repeat(60));

  const crawledDocs = await db.execute(sql`
    SELECT cd.s3_key, cd.board, cd.filename, cd.status
    FROM crawler_documents cd
    WHERE cd.town_id = (SELECT id FROM crawler_towns WHERE slug = ${TOWN_SLUG})
      AND cd.category = 'minutes'
      AND (cd.board LIKE '%Planning%' OR cd.board LIKE '%Zoning%')
      AND cd.status = 'uploaded'
      AND cd.s3_key IS NOT NULL
    ORDER BY cd.board, cd.s3_key
  `);

  console.log(`Found ${crawledDocs.rows.length} uploaded PB/ZBA minutes in crawler_documents\n`);

  const existingKeys = await db.execute(sql`
    SELECT s3_key FROM s3_gemini_sync WHERE s3_key LIKE ${TOWN_SLUG + "/minutes/Planning%"}
       OR s3_key LIKE ${TOWN_SLUG + "/minutes/Zoning%"}
  `);
  const existingSet = new Set((existingKeys.rows as any[]).map((r) => r.s3_key));
  console.log(`${existingSet.size} already in s3_gemini_sync\n`);

  const storeResult = await db.execute(sql`
    SELECT DISTINCT gemini_store_id FROM s3_gemini_sync 
    WHERE lower(town) = ${TOWN_SLUG} AND status = 'synced'
    ORDER BY gemini_store_id
    LIMIT 1
  `);
  const geminiStoreId =
    (storeResult.rows[0] as any)?.gemini_store_id || `pending-${TOWN_SLUG}`;
  console.log(`Using Gemini store: ${geminiStoreId}\n`);

  let inserted = 0;
  let skipped = 0;
  const boardCounts: Record<string, number> = {};
  const yearCounts: Record<string, number> = {};

  const BATCH_SIZE = 50;
  const toInsert: any[] = [];

  for (const row of crawledDocs.rows as any[]) {
    const s3Key: string = row.s3_key;

    if (existingSet.has(s3Key)) {
      skipped++;
      continue;
    }

    const rawBoard: string = row.board || "";
    const normalizedBoard = BOARD_MAP[rawBoard] || rawBoard.replace(/_/g, " ");
    const filename: string = row.filename || s3Key.split("/").pop() || "";
    const year = extractYearFromFilename(filename);

    toInsert.push({
      s3Key,
      geminiStoreId,
      town: TOWN_SLUG,
      category: "minutes",
      board: normalizedBoard,
      year,
      status: "pending",
    });

    boardCounts[normalizedBoard] = (boardCounts[normalizedBoard] || 0) + 1;
    if (year) yearCounts[year] = (yearCounts[year] || 0) + 1;
  }

  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const values = batch
      .map(
        (r: any) =>
          `(gen_random_uuid(), '${r.s3Key.replace(/'/g, "''")}', '${r.geminiStoreId}', '${r.town}', '${r.category}', '${r.board.replace(/'/g, "''")}', ${r.year ? `'${r.year}'` : "NULL"}, 'pending', NOW())`
      )
      .join(",\n");

    await db.execute(
      sql.raw(`
      INSERT INTO s3_gemini_sync (id, s3_key, gemini_store_id, town, category, board, year, status, created_at)
      VALUES ${values}
      ON CONFLICT (s3_key) DO NOTHING
    `)
    );

    inserted += batch.length;
    process.stdout.write(
      `\rInserted ${inserted}/${toInsert.length} records...`
    );
  }

  console.log("\n");
  console.log("=".repeat(60));
  console.log("RESULTS:");
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (already existed): ${skipped}`);
  console.log(`  By board:`);
  Object.entries(boardCounts)
    .sort()
    .forEach(([b, c]) => console.log(`    ${b}: ${c}`));
  console.log(`  By year:`);
  Object.entries(yearCounts)
    .sort()
    .forEach(([y, c]) => console.log(`    ${y}: ${c}`));
  console.log("=".repeat(60));

  const pendingCount = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM s3_gemini_sync WHERE status = 'pending'
  `);
  console.log(
    `\nTotal pending in s3_gemini_sync: ${(pendingCount.rows[0] as any).cnt}`
  );
  console.log(
    "The ingestion worker will pick these up automatically (BATCH_SIZE controls throughput)."
  );
}

bridge()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Bridge failed:", e);
    process.exit(1);
  });
