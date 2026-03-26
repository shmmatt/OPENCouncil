#!/usr/bin/env tsx
/**
 * Find published feed items where the date embedded in the title text
 * ("Board Minutes — March 3, 2026") does not match the meetingDate column,
 * then delete and re-run enrichDocumentMetadata so a fresh title is generated
 * with the correct date.
 *
 * Typical cause: the date extractor initially grabbed an approval date; the
 * backfill script (redate-feed-and-review.ts) corrected meetingDate in the DB,
 * but the title text was generated earlier and still contains the stale date.
 *
 * Flags:
 *   --dry-run   (default) — show what would be regenerated; no DB writes
 *   --execute   — delete stale feed items and re-run enrichDocumentMetadata
 *   --town=X    — restrict to a specific town (case-insensitive)
 */
import "dotenv/config";
import { db } from "../../server/storage/db";
import { eq, inArray, isNotNull, and, sql } from "drizzle-orm";
import * as schema from "../../shared/schema";

const DRY_RUN = !process.argv.includes("--execute");
const TOWN_FILTER = process.argv.find(a => a.startsWith("--town="))?.split("=")[1]?.toLowerCase() || null;

const MONTH_MAP: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

/**
 * Extract a YYYY-MM-DD string from a title like:
 *   "Planning Board Minutes — March 3, 2026"
 * Returns null if no recognisable date is found.
 */
function extractDateFromTitle(title: string): string | null {
  const m = title.match(
    /—\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (!m) return null;
  const month = MONTH_MAP[m[1]] ?? null;
  if (!month) return null;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d as string);
  if (isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(`\n=== regen-misdated-feed-items ===`);
  console.log(`mode:   ${DRY_RUN ? "DRY RUN (no writes)" : "EXECUTE"}`);
  console.log(`town:   ${TOWN_FILTER || "all"}`);
  console.log("");

  // Fetch all published, automation-sourced feed items that have a meetingDate
  const feedItems = await db
    .select({
      id: schema.townFeedItems.id,
      town: schema.townFeedItems.town,
      title: schema.townFeedItems.title,
      meetingDate: schema.townFeedItems.meetingDate,
      versionId: schema.townFeedItems.automationSourceVersionId,
    })
    .from(schema.townFeedItems)
    .where(
      and(
        isNotNull(schema.townFeedItems.publishedAt),
        isNotNull(schema.townFeedItems.automationSourceVersionId),
        isNotNull(schema.townFeedItems.meetingDate),
      )
    );

  // Group by automationSourceVersionId — a single version may have both a
  // Tier-1 digest and a Tier-2 feature article.
  const byVersion = new Map<string, typeof feedItems>();
  for (const item of feedItems) {
    const town = item.town.toLowerCase();
    if (TOWN_FILTER && town !== TOWN_FILTER) continue;

    const titleDate = extractDateFromTitle(item.title);
    const storedDate = isoDate(item.meetingDate);

    // Only flag items where the title date is parseable AND differs from meetingDate
    if (!titleDate || !storedDate || titleDate === storedDate) continue;

    const vid = item.versionId!;
    if (!byVersion.has(vid)) byVersion.set(vid, []);
    byVersion.get(vid)!.push(item);
  }

  if (byVersion.size === 0) {
    console.log("No mismatched feed items found. Nothing to regenerate.");
    return;
  }

  console.log(`Found ${byVersion.size} version(s) with mismatched title dates:\n`);

  let regenerated = 0;
  let errors = 0;

  for (const [versionId, items] of byVersion) {
    for (const item of items) {
      const titleDate = extractDateFromTitle(item.title)!;
      const storedDate = isoDate(item.meetingDate)!;
      console.log(
        `  ${item.town}: "${item.title}"\n` +
        `    title date: ${titleDate}  →  meetingDate: ${storedDate}`
      );
    }

    if (DRY_RUN) continue;

    // Delete all feed items for this version (Tier-1 + Tier-2 if present)
    const idsToDelete = items.map(i => i.id);
    await db
      .delete(schema.townFeedItems)
      .where(inArray(schema.townFeedItems.id, idsToDelete));
    console.log(`    Deleted ${idsToDelete.length} item(s)`);

    // Re-run enrichDocumentMetadata — reads the now-correct meetingDate from
    // document_versions and generates a fresh title
    try {
      const { enrichDocumentMetadata } = await import("../../server/services/enrichDocumentMetadata");
      await enrichDocumentMetadata(versionId);
      console.log(`    Regenerated feed item(s) for version ${versionId}`);
      regenerated++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    ERROR regenerating version ${versionId}: ${msg}`);
      errors++;
    }

    // Brief pause between LLM calls
    await sleep(500);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Versions with mismatched title dates: ${byVersion.size}`);
  if (!DRY_RUN) {
    console.log(`Regenerated:  ${regenerated}`);
    console.log(`Errors:       ${errors}`);
  }
  if (DRY_RUN) console.log(`\n[DRY RUN — no DB writes were made]`);
  else console.log(`\n[EXECUTE — stale items deleted and re-enriched]`);
  console.log("");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
