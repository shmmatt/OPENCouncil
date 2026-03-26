#!/usr/bin/env tsx
/**
 * Re-extract meeting dates for a targeted subset of documents:
 *   1. All document_versions linked to published town_feed_items
 *      (via automationSourceVersionId)
 *   2. All document_versions linked to ingestion_jobs with status='needs_review'
 *      (via fileBlobId → document_versions.fileBlobId)
 *
 * For each version, re-runs suggestMetadataFromPreview on the first ~1000 chars
 * of the blob's OCR/preview text and compares the extracted meetingDate to the
 * stored value.  If they differ, updates document_versions.meetingDate and any
 * linked town_feed_items.meetingDate.
 *
 * Flags:
 *   --dry-run   (default) — show what would change; no DB writes
 *   --execute   — apply changes to the DB
 *   --town=X    — restrict to a specific town (case-insensitive)
 */
import "dotenv/config";
import { db } from "../../server/storage/db";
import { sql, eq, inArray, isNotNull, and } from "drizzle-orm";
import * as schema from "../../shared/schema";
import { suggestMetadataFromPreview } from "../../server/services/metadataExtraction";

const DRY_RUN = !process.argv.includes("--execute");
const TOWN_FILTER = process.argv.find(a => a.startsWith("--town="))?.split("=")[1]?.toLowerCase() || null;
const MIN_DELAY_MS = 300;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

async function main() {
  console.log(`\n=== redate-feed-and-review ===`);
  console.log(`mode:   ${DRY_RUN ? "DRY RUN (no writes)" : "EXECUTE"}`);
  console.log(`town:   ${TOWN_FILTER || "all"}`);
  console.log("");

  // ── Step 1: collect version IDs from published feed items only ───────────
  // Only items with publishedAt set (i.e. status='published') are in scope.
  const feedRows = await db
    .select({
      versionId: schema.townFeedItems.automationSourceVersionId,
      feedItemId: schema.townFeedItems.id,
      feedItemDate: schema.townFeedItems.meetingDate,
    })
    .from(schema.townFeedItems)
    .where(
      and(
        isNotNull(schema.townFeedItems.automationSourceVersionId),
        isNotNull(schema.townFeedItems.publishedAt),
      )
    );

  const feedVersionIdSet = new Set<string>();
  // versionId → list of {feedItemId, feedItemDate}
  const versionToFeedItems = new Map<string, Array<{ feedItemId: string; feedItemDate: Date | null }>>();

  for (const row of feedRows) {
    const vid = row.versionId!;
    feedVersionIdSet.add(vid);
    if (!versionToFeedItems.has(vid)) versionToFeedItems.set(vid, []);
    versionToFeedItems.get(vid)!.push({
      feedItemId: row.feedItemId,
      feedItemDate: row.feedItemDate,
    });
  }

  // ── Step 2: collect version IDs from needs_review ingestion jobs ───────────
  const reviewJobRows = await db.execute(sql`
    SELECT DISTINCT dv.id AS "versionId"
    FROM ingestion_jobs ij
    JOIN document_versions dv ON dv.file_blob_id = ij.file_blob_id
    WHERE ij.status = 'needs_review'
  `);

  const reviewVersionIds = new Set<string>(
    (reviewJobRows.rows as Array<{ versionId: string }>).map(r => r.versionId)
  );

  // ── Step 3: union of all target version IDs ────────────────────────────────
  const allVersionIds = new Set([...feedVersionIdSet, ...reviewVersionIds]);
  if (allVersionIds.size === 0) {
    console.log("No target documents found. Nothing to do.");
    return;
  }
  console.log(`Target versions:  ${allVersionIds.size} total`);
  console.log(`  from feed items: ${feedVersionIdSet.size}`);
  console.log(`  from review:     ${reviewVersionIds.size}`);
  console.log("");

  // ── Step 4: load version metadata + blob text for each target ─────────────
  const versionIdArray = [...allVersionIds];

  // Use ORM query builder so IDs are passed as bind parameters (inArray),
  // not interpolated into raw SQL.  Slice 3000 chars to match the heuristic
  // detection window in detectMinutesHeuristics.
  const versionRows = await db
    .select({
      versionId: schema.documentVersions.id,
      meetingDate: schema.documentVersions.meetingDate,
      town: schema.logicalDocuments.town,
      docTitle: schema.logicalDocuments.canonicalTitle,
      filename: sql<string>`COALESCE(${schema.fileBlobs.originalFilename}, ${schema.logicalDocuments.canonicalTitle})`,
      rawText: sql<string>`LEFT(COALESCE(${schema.fileBlobs.ocrText}, ${schema.fileBlobs.previewText}, ''), 3000)`,
    })
    .from(schema.documentVersions)
    .innerJoin(
      schema.logicalDocuments,
      eq(schema.logicalDocuments.id, schema.documentVersions.documentId),
    )
    .innerJoin(
      schema.fileBlobs,
      eq(schema.fileBlobs.id, schema.documentVersions.fileBlobId),
    )
    .where(
      TOWN_FILTER
        ? and(
            inArray(schema.documentVersions.id, versionIdArray),
            sql`LOWER(${schema.logicalDocuments.town}) = ${TOWN_FILTER}`,
          )
        : inArray(schema.documentVersions.id, versionIdArray),
    )
    .orderBy(schema.logicalDocuments.town, schema.documentVersions.id);

  const versions = versionRows as Array<{
    versionId: string;
    meetingDate: Date | null;
    town: string;
    docTitle: string;
    filename: string;
    rawText: string;
  }>;

  if (versions.length === 0) {
    console.log("No matching versions found after applying town filter.");
    return;
  }

  console.log(`Processing ${versions.length} versions…\n`);

  let changed = 0;
  let unchanged = 0;
  let skippedNoText = 0;
  let errors = 0;

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const prefix = `[${String(i + 1).padStart(3, " ")}/${versions.length}]`;

    if (!v.rawText || v.rawText.trim().length < 20) {
      console.log(`${prefix} SKIP (no text)  ${v.town}: ${v.filename}`);
      skippedNoText++;
      continue;
    }

    let suggested: Awaited<ReturnType<typeof suggestMetadataFromPreview>>;
    try {
      const start = Date.now();
      suggested = await suggestMetadataFromPreview(v.filename, v.rawText, {
        defaultTown: v.town,
      });
      const elapsed = Date.now() - start;
      const remaining = MIN_DELAY_MS - elapsed;
      if (remaining > 0) await sleep(remaining);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${prefix} ERROR   ${v.town}: ${v.filename}: ${msg}`);
      errors++;
      continue;
    }

    const currentDate = isoDate(v.meetingDate);
    const newDate = suggested.meetingDate ?? null;

    if (currentDate === newDate) {
      console.log(`${prefix} OK      ${v.town}: ${v.filename} → ${currentDate ?? "null"}`);
      unchanged++;
      continue;
    }

    console.log(
      `${prefix} CHANGE  ${v.town}: ${v.filename}\n` +
      `              meetingDate: ${currentDate ?? "null"} → ${newDate ?? "null"}`
    );
    changed++;

    if (DRY_RUN) continue;

    const newDateObj = newDate ? new Date(newDate) : null;

    // Update document_versions.meetingDate
    await db
      .update(schema.documentVersions)
      .set({ meetingDate: newDateObj })
      .where(eq(schema.documentVersions.id, v.versionId));

    // Update linked town_feed_items.meetingDate
    const linkedFeedItems = versionToFeedItems.get(v.versionId) ?? [];
    if (linkedFeedItems.length > 0) {
      const feedIds = linkedFeedItems.map(fi => fi.feedItemId);
      await db
        .update(schema.townFeedItems)
        .set({ meetingDate: newDateObj, updatedAt: new Date() })
        .where(inArray(schema.townFeedItems.id, feedIds));
      console.log(`              Updated ${feedIds.length} feed item(s)`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total processed:  ${versions.length}`);
  console.log(`Unchanged:        ${unchanged}`);
  console.log(`Date changed:     ${changed}`);
  console.log(`Skipped (no txt): ${skippedNoText}`);
  console.log(`Errors:           ${errors}`);
  if (DRY_RUN) console.log(`\n[DRY RUN — no DB writes were made]`);
  else console.log(`\n[EXECUTE — all changes written to DB]`);
  console.log("");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
