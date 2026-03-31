/**
 * enrichSauDocuments — Task #42
 *
 * Enrichment pipeline for SAU (School Administrative Unit) documents:
 * 1. Fetches ALL SAU file_blobs via crawler_sau_documents join (including low-text blobs)
 * 2. Creates logical_document + document_version records for blobs that lack them
 * 3. For blobs with sufficient text: calls suggestMetadataFromPreview with SAU-aware hints
 * 4. Patches chunk metadata JSONB (year, meetingDate, documentType, board, sau, sourceType)
 * 5. After enrichment completes, triggers SAU re-embed via startReindex({ sourceType: 'sau' })
 *
 * Runs with rate limiting. Progress is tracked via sauEnrichProgress.
 */

import { db, sql } from "../storage/db";
import { suggestMetadataFromPreview } from "./metadataExtraction";
import { startReindex, isReindexRunning } from "./embeddingPipeline";
import { logInfo, logWarn, logError } from "../utils/logger";

const MIN_TEXT_LENGTH = 100; // Below this, skip LLM but still create logical records

// ---------------------------------------------------------------------------
// Progress state
// ---------------------------------------------------------------------------

export interface SauEnrichProgress {
  status: "idle" | "running" | "stopping" | "stopped" | "completed" | "failed";
  jobId: string | null;
  totalBlobs: number;
  processedBlobs: number;
  enrichedBlobs: number;
  skippedBlobs: number;
  errorBlobs: number;
  currentBlob: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  reembedTriggered: boolean;
}

let sauEnrichProgress: SauEnrichProgress = {
  status: "idle",
  jobId: null,
  totalBlobs: 0,
  processedBlobs: 0,
  enrichedBlobs: 0,
  skippedBlobs: 0,
  errorBlobs: 0,
  currentBlob: null,
  startedAt: null,
  completedAt: null,
  errorMessage: null,
  reembedTriggered: false,
};

let stopRequested = false;

export function getSauEnrichProgress(): SauEnrichProgress {
  return { ...sauEnrichProgress };
}

export function isSauEnrichRunning(): boolean {
  return sauEnrichProgress.status === "running" || sauEnrichProgress.status === "stopping";
}

export function requestSauEnrichStop(): boolean {
  if (!isSauEnrichRunning()) return false;
  stopRequested = true;
  sauEnrichProgress.status = "stopping";
  return true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

interface SauBlobRow {
  file_blob_id: string;
  ocr_text: string | null;
  preview_text: string | null;
  original_filename: string;
  sau_id: string;
  sau_name: string;
  sau_source_id: string;
  sau_doc_id: string;
  has_logical_doc: boolean;
  existing_logical_doc_id: string | null;
}

export async function startSauEnrich(): Promise<void> {
  if (isSauEnrichRunning()) {
    throw new Error("SAU enrichment is already running");
  }

  stopRequested = false;
  const jobId = `sau-enrich-${Date.now()}`;

  sauEnrichProgress = {
    status: "running",
    jobId,
    totalBlobs: 0,
    processedBlobs: 0,
    enrichedBlobs: 0,
    skippedBlobs: 0,
    errorBlobs: 0,
    currentBlob: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
    reembedTriggered: false,
  };

  logInfo(`[SauEnrich] Starting job ${jobId}`);

  try {
    // Fetch ALL SAU file_blobs (including low-text blobs — we still create logical records)
    const result = await db.execute(sql`
      SELECT
        fb.id AS file_blob_id,
        fb.ocr_text,
        fb.preview_text,
        fb.original_filename,
        css.sau_id,
        css.name AS sau_name,
        css.id AS sau_source_id,
        csd.id AS sau_doc_id,
        CASE WHEN EXISTS (
          SELECT 1 FROM document_versions dv2
          WHERE dv2.file_blob_id = fb.id
        ) THEN true ELSE false END AS has_logical_doc,
        (
          SELECT ld.id FROM document_versions dv2
          JOIN logical_documents ld ON ld.id = dv2.document_id
          WHERE dv2.file_blob_id = fb.id
          LIMIT 1
        ) AS existing_logical_doc_id
      FROM crawler_sau_documents csd
      JOIN crawler_sau_sources css ON csd.source_id = css.id
      JOIN file_blobs fb ON csd.file_blob_id = fb.id
      WHERE csd.file_blob_id IS NOT NULL
      ORDER BY css.sau_id, fb.id
    `);

    const blobs = (result.rows as unknown as SauBlobRow[]);
    sauEnrichProgress.totalBlobs = blobs.length;
    logInfo(`[SauEnrich] Found ${blobs.length} SAU blobs to process`);

    const BATCH_DELAY_MS = 300; // rate limit between LLM calls

    for (const blob of blobs) {
      if (stopRequested) {
        logInfo(`[SauEnrich] Stop requested at blob ${blob.file_blob_id}`);
        break;
      }

      sauEnrichProgress.currentBlob = blob.file_blob_id;
      sauEnrichProgress.processedBlobs++;

      const textLength =
        (blob.ocr_text?.length ?? 0) + (blob.preview_text?.length ?? 0);
      const hasText = textLength >= MIN_TEXT_LENGTH;

      try {
        if (hasText) {
          await processSauBlob(blob);
          sauEnrichProgress.enrichedBlobs++;
        } else {
          // Insufficient text: still create logical record linkage but skip LLM
          await createLogicalRecordsOnly(blob);
          sauEnrichProgress.skippedBlobs++;
          logWarn(
            `[SauEnrich] Skipped LLM for blob ${blob.file_blob_id} (text=${textLength} chars < ${MIN_TEXT_LENGTH}), created stub logical records`
          );
        }
      } catch (err: any) {
        logError(`[SauEnrich] Failed blob ${blob.file_blob_id}: ${err.message}`);
        sauEnrichProgress.errorBlobs++;
      }

      // Rate limit only for blobs that call the LLM
      if (hasText) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const finalStatus = stopRequested ? "stopped" : "completed";
    sauEnrichProgress.status = finalStatus;
    sauEnrichProgress.completedAt = new Date().toISOString();
    sauEnrichProgress.currentBlob = null;
    logInfo(
      `[SauEnrich] Job ${jobId} ${finalStatus}: ` +
      `${sauEnrichProgress.enrichedBlobs} enriched, ` +
      `${sauEnrichProgress.skippedBlobs} skipped, ` +
      `${sauEnrichProgress.errorBlobs} errors`
    );

    // Step 5: Trigger SAU re-embed after full enrichment (not when stopped early)
    if (!stopRequested) {
      try {
        if (isReindexRunning()) {
          logWarn(`[SauEnrich] Reindex already running — skipping auto SAU re-embed trigger`);
        } else {
          logInfo(`[SauEnrich] Triggering SAU chunk re-embed (sourceType='sau')...`);
          startReindex({ sourceType: "sau" }).catch(err => {
            logError(`[SauEnrich] SAU re-embed background error: ${err.message}`);
          });
          sauEnrichProgress.reembedTriggered = true;
          logInfo(`[SauEnrich] SAU re-embed triggered successfully`);
        }
      } catch (err: any) {
        logError(`[SauEnrich] Failed to trigger SAU re-embed: ${err.message}`);
      }
    }
  } catch (err: any) {
    logError(`[SauEnrich] Job ${jobId} failed: ${err.message}`);
    sauEnrichProgress.status = "failed";
    sauEnrichProgress.errorMessage = err.message;
    sauEnrichProgress.completedAt = new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Create logical records only (no LLM) for blobs without sufficient text
// ---------------------------------------------------------------------------

async function createLogicalRecordsOnly(blob: SauBlobRow): Promise<void> {
  if (blob.existing_logical_doc_id) {
    // Ensure chunk metadata has sourceType / sau set even for stub blobs
    await db.execute(sql`
      UPDATE document_chunks
      SET metadata = metadata || ${JSON.stringify({
        sourceType: "sau",
        sau: blob.sau_id,
        documentId: blob.existing_logical_doc_id,
      })}::jsonb,
          document_id = ${blob.existing_logical_doc_id}
      WHERE file_blob_id = ${blob.file_blob_id}
    `);
    return;
  }

  // Create stub logical_document
  const ldResult = await db.execute(sql`
    INSERT INTO logical_documents (canonical_title, town, board, category, created_at, updated_at)
    VALUES (
      ${blob.sau_name + " — Document"},
      'unknown',
      ${blob.sau_name},
      'misc_other',
      NOW(),
      NOW()
    )
    RETURNING id
  `);
  const logicalDocId = (ldResult.rows as any[])[0]?.id as string;
  if (!logicalDocId) return;

  const dvResult = await db.execute(sql`
    INSERT INTO document_versions (document_id, file_blob_id, is_current, is_minutes, created_at)
    VALUES (${logicalDocId}, ${blob.file_blob_id}, true, false, NOW())
    RETURNING id
  `);
  const versionId = (dvResult.rows as any[])[0]?.id ?? null;

  if (versionId) {
    await db.execute(sql`
      UPDATE logical_documents SET current_version_id = ${versionId}, updated_at = NOW()
      WHERE id = ${logicalDocId}
    `);
  }

  await db.execute(sql`
    UPDATE document_chunks
    SET metadata = metadata || ${JSON.stringify({
      sourceType: "sau",
      sau: blob.sau_id,
      documentId: logicalDocId,
    })}::jsonb,
        document_id = ${logicalDocId}
    WHERE file_blob_id = ${blob.file_blob_id}
  `);
}

// ---------------------------------------------------------------------------
// Full per-blob processing with LLM enrichment
// ---------------------------------------------------------------------------

async function processSauBlob(blob: SauBlobRow): Promise<void> {
  const previewText = blob.ocr_text || blob.preview_text || "";

  let suggested: Awaited<ReturnType<typeof suggestMetadataFromPreview>>;
  try {
    suggested = await suggestMetadataFromPreview(
      blob.original_filename,
      previewText,
      {
        defaultTown: undefined,
        defaultBoard: blob.sau_name,
        isSauDocument: true,
        sauId: blob.sau_id,
        sauName: blob.sau_name,
      }
    );
  } catch (err: any) {
    logError(`[SauEnrich] LLM call failed for blob ${blob.file_blob_id}: ${err.message}`);
    throw err;
  }

  logInfo(
    `[SauEnrich] blob=${blob.file_blob_id} sau=${blob.sau_id} ` +
    `board="${suggested.board}" date="${suggested.meetingDate}" ` +
    `category="${suggested.category}"`
  );

  // ------------------------------------------------------------------
  // Determine logical_doc_id: create one if missing
  // ------------------------------------------------------------------
  let logicalDocId = blob.existing_logical_doc_id;

  if (!logicalDocId) {
    const titleParts: string[] = [];
    const board = (suggested.board && suggested.board.length > 0)
      ? suggested.board
      : blob.sau_name;
    titleParts.push(board);

    if (suggested.meetingDate) {
      try {
        const d = new Date(suggested.meetingDate);
        if (!isNaN(d.getTime())) {
          titleParts.push(d.toLocaleDateString("en-US", { month: "long", year: "numeric" }));
        }
      } catch { /* ignore */ }
    } else if (suggested.year) {
      titleParts.push(suggested.year);
    }
    const canonicalTitle = titleParts.join(" — ");
    const category = suggested.isMinutes ? "meeting_minutes" : (suggested.category || "misc_other");

    const ldResult = await db.execute(sql`
      INSERT INTO logical_documents (canonical_title, town, board, category, created_at, updated_at)
      VALUES (
        ${canonicalTitle},
        'unknown',
        ${board},
        ${category},
        NOW(),
        NOW()
      )
      RETURNING id
    `);
    logicalDocId = (ldResult.rows as any[])[0]?.id as string;
    if (!logicalDocId) throw new Error(`Failed to create logical_document for blob ${blob.file_blob_id}`);

    let meetingDate: Date | null = null;
    if (suggested.meetingDate) {
      try {
        const d = new Date(suggested.meetingDate);
        if (!isNaN(d.getTime())) meetingDate = d;
      } catch { /* ignore */ }
    }
    const yearStr = suggested.year || (meetingDate ? String(meetingDate.getFullYear()) : null);

    const dvResult = await db.execute(sql`
      INSERT INTO document_versions (document_id, file_blob_id, year, is_current, is_minutes, meeting_date, created_at)
      VALUES (
        ${logicalDocId},
        ${blob.file_blob_id},
        ${yearStr},
        true,
        ${Boolean(suggested.isMinutes)},
        ${meetingDate},
        NOW()
      )
      RETURNING id
    `);
    const versionId = (dvResult.rows as any[])[0]?.id ?? null;

    if (versionId) {
      await db.execute(sql`
        UPDATE logical_documents
        SET current_version_id = ${versionId}, updated_at = NOW()
        WHERE id = ${logicalDocId}
      `);
    }

    logInfo(`[SauEnrich] Created logDoc=${logicalDocId} version=${versionId} for blob=${blob.file_blob_id}`);
  } else {
    // Update existing logical_doc board/category if enrichment improved them
    const board = suggested.board && suggested.board.length > 0 ? suggested.board : null;
    if (board) {
      await db.execute(sql`
        UPDATE logical_documents
        SET board = ${board},
            category = ${suggested.isMinutes ? "meeting_minutes" : suggested.category},
            updated_at = NOW()
        WHERE id = ${logicalDocId}
          AND (board IS NULL OR board = 'Needs Review' OR board = '')
      `);
    }

    if (suggested.meetingDate) {
      try {
        const d = new Date(suggested.meetingDate);
        if (!isNaN(d.getTime())) {
          await db.execute(sql`
            UPDATE document_versions
            SET meeting_date = ${d}, is_minutes = ${Boolean(suggested.isMinutes)}
            WHERE file_blob_id = ${blob.file_blob_id}
              AND meeting_date IS NULL
          `);
        }
      } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------
  // Patch document_chunks metadata
  // ------------------------------------------------------------------
  const chunkPatch: Record<string, unknown> = {
    sourceType: "sau",
    sau: blob.sau_id,
    documentId: logicalDocId,
  };

  const resolvedBoard = (suggested.board && suggested.board.length > 0)
    ? suggested.board
    : blob.sau_name;
  chunkPatch.board = resolvedBoard;

  const category = suggested.isMinutes ? "meeting_minutes" : (suggested.category || "misc_other");
  chunkPatch.documentType = category;

  if (suggested.meetingDate) {
    try {
      const d = new Date(suggested.meetingDate);
      if (!isNaN(d.getTime())) {
        chunkPatch.year = d.getFullYear();
        chunkPatch.meetingDate = d.toISOString();
      }
    } catch { /* ignore */ }
  } else if (suggested.year) {
    const yr = parseInt(suggested.year);
    if (!isNaN(yr)) chunkPatch.year = yr;
  }

  const patchResult = await db.execute(sql`
    UPDATE document_chunks
    SET metadata = metadata || ${JSON.stringify(chunkPatch)}::jsonb,
        document_id = ${logicalDocId}
    WHERE file_blob_id = ${blob.file_blob_id}
  `);

  logInfo(
    `[SauEnrich] Patched ${patchResult.rowCount ?? 0} chunks for blob=${blob.file_blob_id} ` +
    `[board="${resolvedBoard}", type="${category}", date="${chunkPatch.meetingDate ?? ''}"]`
  );
}
