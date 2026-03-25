/**
 * enrichDocumentMetadata — Task #27
 *
 * Standalone service that:
 * 1. Fetches a document version + logical document + file blob
 * 2. Runs suggestMetadataFromPreview if board="Needs Review"/null OR meetingDate=null
 * 3. Patches logical_documents.board, logical_documents.category,
 *    document_versions.meeting_date, document_versions.is_minutes
 * 4. Calls processDocumentForFeed only if extracted meetingDate >= 2026-02-01
 *
 * Called fire-and-forget from the crawler (bridgeToLogicalDocument) and the
 * /api/admin/content/enrich-metadata backfill endpoint.
 */

import { db, schema, eq } from "../storage/db";
import { suggestMetadataFromPreview } from "./metadataExtraction";
import { logInfo, logWarn, logError } from "../utils/logger";

const FEED_CUTOFF = new Date("2026-02-01");

export async function enrichDocumentMetadata(versionId: string): Promise<void> {
  logInfo(`[enrichMetadata] Starting for version ${versionId}`);

  // 1. Fetch version
  const [version] = await db
    .select()
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.id, versionId))
    .limit(1);

  if (!version) {
    logWarn(`[enrichMetadata] Version not found: ${versionId}`);
    return;
  }

  // 2. Fetch logical document
  const [logDoc] = await db
    .select()
    .from(schema.logicalDocuments)
    .where(eq(schema.logicalDocuments.id, version.documentId))
    .limit(1);

  if (!logDoc) {
    logWarn(`[enrichMetadata] Logical document not found for version ${versionId}`);
    return;
  }

  // 3. Determine if enrichment is needed
  const needsBoard = !logDoc.board || logDoc.board === "Needs Review";
  const needsMeetingDate = !version.meetingDate;

  if (!needsBoard && !needsMeetingDate) {
    logInfo(`[enrichMetadata] Version ${versionId} already fully enriched — skipping LLM`);
    // Still attempt feed generation if meetingDate qualifies
    await maybeGenerateFeedItem(versionId, version.meetingDate as Date | null);
    return;
  }

  // 4. Fetch blob text
  const [blob] = await db
    .select()
    .from(schema.fileBlobs)
    .where(eq(schema.fileBlobs.id, version.fileBlobId))
    .limit(1);

  const previewText = blob?.ocrText || blob?.previewText || "";

  if (!previewText || previewText.length < 50) {
    logWarn(`[enrichMetadata] Insufficient text for version ${versionId} (${previewText.length} chars) — skipping LLM`);
    return;
  }

  const filename = blob?.originalFilename || logDoc.canonicalTitle;

  // 5. Call LLM metadata extraction
  let suggested: Awaited<ReturnType<typeof suggestMetadataFromPreview>>;
  try {
    suggested = await suggestMetadataFromPreview(filename, previewText, {
      defaultTown: logDoc.town,
      defaultBoard: (!logDoc.board || logDoc.board === "Needs Review") ? undefined : logDoc.board,
    });
  } catch (err: any) {
    logError(`[enrichMetadata] suggestMetadataFromPreview failed for version ${versionId}: ${err.message}`);
    return;
  }

  logInfo(
    `[enrichMetadata] LLM result for ${versionId}: board="${suggested.board}", ` +
    `meetingDate="${suggested.meetingDate}", isMinutes=${suggested.isMinutes}, category="${suggested.category}"`
  );

  // 6. Patch logical_documents (board + category) if needed
  const newBoard = suggested.board || logDoc.board || null;
  const newCategory = suggested.isMinutes ? "meeting_minutes" : (suggested.category || logDoc.category);

  if (needsBoard && newBoard && newBoard !== logDoc.board) {
    await db
      .update(schema.logicalDocuments)
      .set({ board: newBoard, category: newCategory, updatedAt: new Date() })
      .where(eq(schema.logicalDocuments.id, logDoc.id));
    logInfo(`[enrichMetadata] Updated logDoc ${logDoc.id}: board="${newBoard}", category="${newCategory}"`);
  } else if (newCategory !== logDoc.category) {
    await db
      .update(schema.logicalDocuments)
      .set({ category: newCategory, updatedAt: new Date() })
      .where(eq(schema.logicalDocuments.id, logDoc.id));
    logInfo(`[enrichMetadata] Updated logDoc ${logDoc.id}: category="${newCategory}"`);
  }

  // 7. Patch document_versions (meeting_date + is_minutes) if needed
  let finalMeetingDate: Date | null = null;
  if (suggested.meetingDate) {
    try {
      const parsed = new Date(suggested.meetingDate);
      if (!isNaN(parsed.getTime())) {
        finalMeetingDate = parsed;
      }
    } catch {
      // ignore parse error
    }
  }

  if (needsMeetingDate && finalMeetingDate) {
    await db
      .update(schema.documentVersions)
      .set({ meetingDate: finalMeetingDate, isMinutes: suggested.isMinutes })
      .where(eq(schema.documentVersions.id, versionId));
    logInfo(`[enrichMetadata] Updated version ${versionId}: meetingDate=${finalMeetingDate.toISOString()}, isMinutes=${suggested.isMinutes}`);
  } else if (version.isMinutes !== suggested.isMinutes) {
    await db
      .update(schema.documentVersions)
      .set({ isMinutes: suggested.isMinutes })
      .where(eq(schema.documentVersions.id, versionId));
    logInfo(`[enrichMetadata] Updated version ${versionId}: isMinutes=${suggested.isMinutes}`);
  }

  // 8. Attempt feed generation if meetingDate qualifies
  await maybeGenerateFeedItem(versionId, finalMeetingDate);
}

async function maybeGenerateFeedItem(
  versionId: string,
  meetingDate: Date | null
): Promise<void> {
  if (!meetingDate || meetingDate < FEED_CUTOFF) {
    logInfo(
      `[enrichMetadata] Skipping feed generation for version ${versionId}: ` +
      `meetingDate=${meetingDate?.toISOString() ?? "null"} (cutoff: ${FEED_CUTOFF.toISOString()})`
    );
    return;
  }

  // Import dynamically to avoid circular deps
  const { processDocumentForFeed } = await import("./feedAutomation");
  try {
    await processDocumentForFeed(versionId);
  } catch (err: any) {
    logError(`[enrichMetadata] Feed generation failed for version ${versionId}: ${err.message}`);
  }
}
