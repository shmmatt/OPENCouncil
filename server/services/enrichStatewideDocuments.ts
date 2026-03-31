/**
 * enrichStatewideDocuments — Task #43
 *
 * Backfill enrichment pipeline for statewide NH documents (19,315 chunks):
 * - Queries logical_documents where town='statewide' AND (board IS NULL OR board='Needs Review' OR category='general')
 * - For each: fetches file_blob text, calls suggestMetadataFromPreview with statewide hints
 * - Patches logical_documents.board, logical_documents.category
 * - Patches document_versions.year if missing
 * - Syncs chunk metadata JSONB via existing chunk patch pattern (board, documentType, year)
 * - After full completion, triggers re-embed scoped to town='statewide'
 *
 * Idempotent: blobs already having board != null AND board != 'Needs Review' are skipped.
 * Rate-limited at 300ms per LLM call.
 */

import { db, sql } from "../storage/db";
import { suggestMetadataFromPreview } from "./metadataExtraction";
import type { StatewideMetadataHints } from "./metadataExtraction";
import { startReindex, isReindexRunning } from "./embeddingPipeline";
import { logInfo, logWarn, logError } from "../utils/logger";

const MIN_TEXT_LENGTH = 50;
const RATE_LIMIT_MS = 300;

// ---------------------------------------------------------------------------
// Progress state
// ---------------------------------------------------------------------------

export interface StatewideEnrichProgress {
  status: "idle" | "running" | "stopping" | "stopped" | "completed" | "failed";
  jobId: string | null;
  totalDocs: number;
  processedDocs: number;
  enrichedDocs: number;
  skippedDocs: number;
  errorDocs: number;
  currentDoc: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  reembedTriggered: boolean;
}

let statewideEnrichProgress: StatewideEnrichProgress = {
  status: "idle",
  jobId: null,
  totalDocs: 0,
  processedDocs: 0,
  enrichedDocs: 0,
  skippedDocs: 0,
  errorDocs: 0,
  currentDoc: null,
  startedAt: null,
  completedAt: null,
  errorMessage: null,
  reembedTriggered: false,
};

let stopRequested = false;

export function getStatewideEnrichProgress(): StatewideEnrichProgress {
  return { ...statewideEnrichProgress };
}

export function isStatewideEnrichRunning(): boolean {
  return (
    statewideEnrichProgress.status === "running" ||
    statewideEnrichProgress.status === "stopping"
  );
}

export function requestStatewideEnrichStop(): boolean {
  if (!isStatewideEnrichRunning()) return false;
  stopRequested = true;
  statewideEnrichProgress.status = "stopping";
  return true;
}

// ---------------------------------------------------------------------------
// Row type returned from the query
// ---------------------------------------------------------------------------

interface StatewideDocRow {
  logical_doc_id: string;
  canonical_title: string;
  current_board: string | null;
  current_category: string;
  version_id: string | null;
  file_blob_id: string | null;
  original_filename: string | null;
  ocr_text: string | null;
  preview_text: string | null;
  version_year: string | null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function startStatewideEnrich(): Promise<void> {
  if (isStatewideEnrichRunning()) {
    throw new Error("Statewide enrichment is already running");
  }

  stopRequested = false;
  const jobId = `statewide-enrich-${Date.now()}`;

  statewideEnrichProgress = {
    status: "running",
    jobId,
    totalDocs: 0,
    processedDocs: 0,
    enrichedDocs: 0,
    skippedDocs: 0,
    errorDocs: 0,
    currentDoc: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
    reembedTriggered: false,
  };

  logInfo(`[StatewideEnrich] Starting job ${jobId}`);

  try {
    // Fetch statewide logical_documents needing enrichment:
    // board IS NULL OR board = 'Needs Review' OR category = 'general' OR category = 'misc_other'
    // Joined with their current_version → file_blob for text
    const result = await db.execute(sql`
      SELECT
        ld.id AS logical_doc_id,
        ld.canonical_title,
        ld.board AS current_board,
        ld.category AS current_category,
        dv.id AS version_id,
        dv.file_blob_id,
        dv.year AS version_year,
        fb.original_filename,
        fb.ocr_text,
        fb.preview_text
      FROM logical_documents ld
      LEFT JOIN document_versions dv ON dv.id = ld.current_version_id
      LEFT JOIN file_blobs fb ON fb.id = dv.file_blob_id
      WHERE ld.town = 'statewide'
        AND (
          ld.board IS NULL
          OR ld.board = 'Needs Review'
          OR ld.board = ''
          OR ld.category = 'general'
          OR ld.category = 'misc_other'
        )
      ORDER BY ld.created_at
    `);

    const docs = result.rows as unknown as StatewideDocRow[];
    statewideEnrichProgress.totalDocs = docs.length;
    logInfo(`[StatewideEnrich] Found ${docs.length} statewide docs to process`);

    for (const doc of docs) {
      if (stopRequested) {
        logInfo(`[StatewideEnrich] Stop requested at doc ${doc.logical_doc_id}`);
        break;
      }

      statewideEnrichProgress.currentDoc = doc.logical_doc_id;
      statewideEnrichProgress.processedDocs++;

      const textLength =
        (doc.ocr_text?.length ?? 0) + (doc.preview_text?.length ?? 0);

      if (textLength < MIN_TEXT_LENGTH) {
        statewideEnrichProgress.skippedDocs++;
        logWarn(
          `[StatewideEnrich] Skipped doc=${doc.logical_doc_id} (text=${textLength} chars < ${MIN_TEXT_LENGTH})`
        );
        continue;
      }

      try {
        await processStatewideDoc(doc);
        statewideEnrichProgress.enrichedDocs++;
      } catch (err: any) {
        logError(
          `[StatewideEnrich] Failed doc ${doc.logical_doc_id}: ${err.message}`
        );
        statewideEnrichProgress.errorDocs++;
      }

      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS));
    }

    const finalStatus = stopRequested ? "stopped" : "completed";
    statewideEnrichProgress.status = finalStatus;
    statewideEnrichProgress.completedAt = new Date().toISOString();
    statewideEnrichProgress.currentDoc = null;
    logInfo(
      `[StatewideEnrich] Job ${jobId} ${finalStatus}: ` +
      `${statewideEnrichProgress.enrichedDocs} enriched, ` +
      `${statewideEnrichProgress.skippedDocs} skipped, ` +
      `${statewideEnrichProgress.errorDocs} errors`
    );

    // Trigger statewide re-embed after full completion (not when stopped early)
    if (!stopRequested) {
      try {
        if (isReindexRunning()) {
          logWarn(
            `[StatewideEnrich] Reindex already running — skipping auto statewide re-embed trigger`
          );
        } else {
          logInfo(`[StatewideEnrich] Triggering statewide chunk re-embed (town='statewide')...`);
          startReindex({ town: "statewide" }).catch(err => {
            logError(`[StatewideEnrich] Statewide re-embed background error: ${err.message}`);
          });
          statewideEnrichProgress.reembedTriggered = true;
          logInfo(`[StatewideEnrich] Statewide re-embed triggered successfully`);
        }
      } catch (err: any) {
        logError(`[StatewideEnrich] Failed to trigger statewide re-embed: ${err.message}`);
      }
    }
  } catch (err: any) {
    logError(`[StatewideEnrich] Job ${jobId} failed: ${err.message}`);
    statewideEnrichProgress.status = "failed";
    statewideEnrichProgress.errorMessage = err.message;
    statewideEnrichProgress.completedAt = new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Per-document processing
// ---------------------------------------------------------------------------

async function processStatewideDoc(doc: StatewideDocRow): Promise<void> {
  const previewText = doc.ocr_text || doc.preview_text || "";
  const filename = doc.original_filename || doc.canonical_title || "statewide-document";

  const hints: StatewideMetadataHints = {
    isStatewideDocument: true,
    documentTitle: doc.canonical_title,
    defaultTown: "statewide",
  };

  let suggested: Awaited<ReturnType<typeof suggestMetadataFromPreview>>;
  try {
    suggested = await suggestMetadataFromPreview(filename, previewText, hints);
  } catch (err: any) {
    logError(
      `[StatewideEnrich] LLM failed for doc=${doc.logical_doc_id}: ${err.message}`
    );
    throw err;
  }

  const newBoard = suggested.board && suggested.board.length > 0
    ? suggested.board
    : null;

  // Skip category update if the LLM returned a vague category and we already have something better
  const vagueCats = new Set(["misc_other", "general", ""]);
  const currentIsVague = vagueCats.has(doc.current_category ?? "");
  const suggestedCategory = suggested.isMinutes
    ? "meeting_minutes"
    : suggested.category || doc.current_category;
  const newCategory = (suggestedCategory && !vagueCats.has(suggestedCategory))
    ? suggestedCategory
    : (currentIsVague ? (suggestedCategory || doc.current_category) : doc.current_category);

  logInfo(
    `[StatewideEnrich] doc=${doc.logical_doc_id} board="${newBoard}" ` +
    `category="${newCategory}" (was: board="${doc.current_board}", cat="${doc.current_category}")`
  );

  // Patch logical_documents
  let didUpdateLogDoc = false;
  const needsBoardUpdate = newBoard && newBoard !== doc.current_board &&
    newBoard !== "Needs Review" && newBoard !== "";
  const needsCategoryUpdate = newCategory && newCategory !== doc.current_category;

  if (needsBoardUpdate || needsCategoryUpdate) {
    await db.execute(sql`
      UPDATE logical_documents
      SET
        board = CASE WHEN ${needsBoardUpdate} THEN ${newBoard} ELSE board END,
        category = CASE WHEN ${needsCategoryUpdate} THEN ${newCategory} ELSE category END,
        updated_at = NOW()
      WHERE id = ${doc.logical_doc_id}
    `);
    didUpdateLogDoc = true;
    logInfo(
      `[StatewideEnrich] Updated logDoc=${doc.logical_doc_id}: ` +
      `board="${newBoard}", category="${newCategory}"`
    );
  }

  // Patch document_versions.year if missing
  if (doc.version_id && !doc.version_year && suggested.year) {
    await db.execute(sql`
      UPDATE document_versions
      SET year = COALESCE(year, ${suggested.year})
      WHERE id = ${doc.version_id}
        AND year IS NULL
    `);
  }

  // Sync chunk metadata JSONB
  if (didUpdateLogDoc && doc.file_blob_id) {
    const chunkPatch: Record<string, unknown> = {};
    if (newBoard) chunkPatch.board = newBoard;
    if (newCategory) chunkPatch.documentType = newCategory;
    if (suggested.year) {
      const yr = parseInt(suggested.year);
      if (!isNaN(yr)) chunkPatch.year = yr;
    }

    if (Object.keys(chunkPatch).length > 0) {
      try {
        const patchResult = await db.execute(sql`
          UPDATE document_chunks
          SET metadata = metadata || ${JSON.stringify(chunkPatch)}::jsonb
          WHERE file_blob_id = ${doc.file_blob_id}
        `);
        logInfo(
          `[StatewideEnrich] Patched ${patchResult.rowCount ?? 0} chunks for blob=${doc.file_blob_id} ` +
          `[board="${chunkPatch.board ?? "unchanged"}", type="${chunkPatch.documentType ?? "unchanged"}"]`
        );
      } catch (err: any) {
        logError(
          `[StatewideEnrich] Chunk patch failed for blob ${doc.file_blob_id}: ${err.message}`
        );
      }
    }
  }
}
