#!/usr/bin/env tsx
/**
 * Re-run header-only board extraction on all meeting_minutes documents
 * and update logical_documents.board where the result differs.
 *
 * For documents whose board changed AND meetingDate >= 2026-02-01:
 *   1. DELETE existing town_feed_items (awaited — avoids race condition)
 *   2. Call enrichDocumentMetadata to regenerate a fresh feed item
 *
 * Flags:
 *   --dry-run        Print what would change without writing to DB
 *   --town=<name>    Restrict to a specific town (case-insensitive)
 *   --limit=<n>      Cap how many documents to process (default: all)
 *   --offset=<n>     Skip the first N documents (for chunked runs)
 */
import "dotenv/config";
import { db } from "../../server/storage/db";
import { sql, eq, inArray } from "drizzle-orm";
import * as schema from "../../shared/schema";
import { suggestMetadataFromPreview } from "../../server/services/metadataExtraction";

const DRY_RUN = process.argv.includes("--dry-run");
const TOWN_FILTER = process.argv.find(a => a.startsWith("--town="))?.split("=")[1]?.toLowerCase() || null;
const BATCH_LIMIT = parseInt(
  process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "0",
  10
) || 999_999;
const BATCH_OFFSET = parseInt(
  process.argv.find(a => a.startsWith("--offset="))?.split("=")[1] || "0",
  10
) || 0;

const FEED_CUTOFF = new Date("2026-02-01");
const MIN_DELAY_MS = 200;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBoard(b: string | null | undefined): string {
  return (b || "").trim().toLowerCase();
}

async function main() {
  console.log(`\n=== reboard-all-minutes ===`);
  console.log(`dry-run: ${DRY_RUN} | town: ${TOWN_FILTER || "all"} | limit: ${BATCH_LIMIT} | offset: ${BATCH_OFFSET}`);
  console.log("");

  // Query all meeting_minutes logical documents with one version per doc.
  // DISTINCT ON (ld.id) ORDER BY ld.id, dv.id DESC picks the latest version.
  // LEFT() on OCR text ensures we fetch only the first 1,000 chars from DB —
  // avoids pulling full OCR bodies (which can be 100k+ chars) over the wire.
  // is_minutes predicate is intentionally omitted: category='meeting_minutes'
  // is the authoritative signal; legacy docs may be miscategorised on is_minutes.
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (ld.id)
      ld.id          AS "logDocId",
      ld.board       AS "currentBoard",
      ld.town        AS "town",
      ld.canonical_title AS "title",
      dv.id          AS "versionId",
      dv.meeting_date AS "meetingDate",
      COALESCE(fb.original_filename, ld.canonical_title) AS "filename",
      LEFT(COALESCE(fb.ocr_text, fb.preview_text, ''), 1000) AS "rawText"
    FROM logical_documents ld
    JOIN document_versions dv ON dv.document_id = ld.id
    JOIN file_blobs fb ON fb.id = dv.file_blob_id
    WHERE ld.category = 'meeting_minutes'
      ${TOWN_FILTER ? sql`AND LOWER(ld.town) = ${TOWN_FILTER}` : sql``}
    ORDER BY ld.id, dv.id DESC
    LIMIT ${BATCH_LIMIT} OFFSET ${BATCH_OFFSET}
  `);

  const docs = rows.rows as Array<{
    logDocId: string;
    currentBoard: string | null;
    town: string;
    title: string;
    versionId: string;
    meetingDate: Date | null;
    filename: string;
    rawText: string;
  }>;

  console.log(`Found ${docs.length} meeting_minutes documents to process\n`);

  let changed = 0;
  let unchanged = 0;
  let skippedNoText = 0;
  let errors = 0;
  let feedRegenQueued = 0;

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const headerText = (doc.rawText || "").slice(0, 1000);

    if (headerText.length < 20) {
      console.log(`[${i + 1}/${docs.length}] SKIP (no text) — ${doc.town}: ${doc.filename}`);
      skippedNoText++;
      continue;
    }

    let suggested: Awaited<ReturnType<typeof suggestMetadataFromPreview>>;
    try {
      const start = Date.now();
      suggested = await suggestMetadataFromPreview(doc.filename, headerText, {
        defaultTown: doc.town,
      });
      const elapsed = Date.now() - start;

      // Rate-limit: ensure at least MIN_DELAY_MS between calls
      const remaining = MIN_DELAY_MS - elapsed;
      if (remaining > 0) await sleep(remaining);
    } catch (err: any) {
      console.error(`[${i + 1}/${docs.length}] ERROR — ${doc.town}: ${doc.filename}: ${err.message}`);
      errors++;
      continue;
    }

    const newBoard = suggested.board?.trim() || null;
    const currentBoard = doc.currentBoard?.trim() || null;

    const isSameBoard = normalizeBoard(newBoard) === normalizeBoard(currentBoard);

    if (isSameBoard || !newBoard) {
      console.log(`[${i + 1}/${docs.length}] OK    ${doc.town}: ${doc.filename} → "${currentBoard}"`);
      unchanged++;
      continue;
    }

    console.log(
      `[${i + 1}/${docs.length}] CHANGE ${doc.town}: ${doc.filename}\n` +
      `         "${currentBoard}" → "${newBoard}"`
    );
    changed++;

    if (DRY_RUN) continue;

    // Update the board in logical_documents
    await db
      .update(schema.logicalDocuments)
      .set({ board: newBoard, updatedAt: new Date() })
      .where(eq(schema.logicalDocuments.id, doc.logDocId));

    // If meetingDate >= cutoff, delete stale feed items then re-enrich
    const meetingDate = doc.meetingDate ? new Date(doc.meetingDate) : null;
    if (meetingDate && meetingDate >= FEED_CUTOFF) {
      // Step 1: find feed items sourced from this version
      const existingFeedItems = await db
        .select({ id: schema.townFeedItems.id })
        .from(schema.townFeedItems)
        .where(eq(schema.townFeedItems.automationSourceVersionId, doc.versionId));

      if (existingFeedItems.length > 0) {
        const ids = existingFeedItems.map(fi => fi.id);
        // AWAIT the deletion before queuing enrichDocumentMetadata
        await db
          .delete(schema.townFeedItems)
          .where(inArray(schema.townFeedItems.id, ids));
        console.log(`         Deleted ${ids.length} stale feed item(s)`);
      }

      // Step 2: re-enrich (fire-and-forget, but awaited here to stay rate-limited)
      try {
        const { enrichDocumentMetadata } = await import("../../server/services/enrichDocumentMetadata");
        await enrichDocumentMetadata(doc.versionId);
        feedRegenQueued++;
        console.log(`         Feed item regenerated`);
      } catch (err: any) {
        console.warn(`         enrichDocumentMetadata failed: ${err.message}`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total:           ${docs.length}`);
  console.log(`Unchanged:       ${unchanged}`);
  console.log(`Changed board:   ${changed}`);
  console.log(`Skipped (no txt):${skippedNoText}`);
  console.log(`Errors:          ${errors}`);
  console.log(`Feed regens:     ${feedRegenQueued}`);
  if (DRY_RUN) console.log(`\n[DRY RUN — no DB writes were made]`);
  console.log("");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
