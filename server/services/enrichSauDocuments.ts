/**
 * enrichSauDocuments — Task #42
 *
 * Enrichment pipeline for SAU (School Administrative Unit) documents:
 * 1. Fetches all SAU file_blobs via crawler_sau_documents join
 * 2. Calls suggestMetadataFromPreview with SAU-aware hints (no town field needed)
 * 3. Creates logical_document + document_version records if missing
 * 4. Patches chunk metadata JSONB (year, meetingDate, documentType, board, sau, sourceType)
 *
 * Runs in batches with rate limiting. Progress is tracked via sauEnrichProgress.
 */

import { db, sql } from "../storage/db";
import { suggestMetadataFromPreview } from "./metadataExtraction";
import { logInfo, logWarn, logError } from "../utils/logger";

// ---------------------------------------------------------------------------
// Progress state
// ---------------------------------------------------------------------------

export interface SauEnrichProgress {
  status: "idle" | "running" | "stopping" | "completed" | "failed";
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
  };

  logInfo(`[SauEnrich] Starting job ${jobId}`);

  try {
    // Fetch all SAU file_blobs with their SAU source info
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
        AND (fb.ocr_text IS NOT NULL OR fb.preview_text IS NOT NULL)
        AND (
          COALESCE(char_length(fb.ocr_text), 0) +
          COALESCE(char_length(fb.preview_text), 0)
        ) > 100
      ORDER BY css.sau_id, fb.id
    `);

    const blobs = (result.rows as unknown as SauBlobRow[]);
    sauEnrichProgress.totalBlobs = blobs.length;
    logInfo(`[SauEnrich] Found ${blobs.length} SAU blobs to process`);

    const BATCH_DELAY_MS = 300; // rate limit between LLM calls

    for (const blob of blobs) {
      if (stopRequested) {
        logInfo(`[SauEnrich] Stop requested at blob ${blob.file_blob_id}`);
        sauEnrichProgress.status = "stopping";
        break;
      }

      sauEnrichProgress.currentBlob = blob.file_blob_id;
      sauEnrichProgress.processedBlobs++;

      try {
        await processSauBlob(blob);
        sauEnrichProgress.enrichedBlobs++;
      } catch (err: any) {
        logError(`[SauEnrich] Failed blob ${blob.file_blob_id}: ${err.message}`);
        sauEnrichProgress.errorBlobs++;
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }

    sauEnrichProgress.status = stopRequested ? "completed" : "completed";
    sauEnrichProgress.completedAt = new Date().toISOString();
    sauEnrichProgress.currentBlob = null;
    logInfo(
      `[SauEnrich] Job ${jobId} completed: ` +
      `${sauEnrichProgress.enrichedBlobs} enriched, ` +
      `${sauEnrichProgress.skippedBlobs} skipped, ` +
      `${sauEnrichProgress.errorBlobs} errors`
    );
  } catch (err: any) {
    logError(`[SauEnrich] Job ${jobId} failed: ${err.message}`);
    sauEnrichProgress.status = "failed";
    sauEnrichProgress.errorMessage = err.message;
    sauEnrichProgress.completedAt = new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Per-blob processing
// ---------------------------------------------------------------------------

async function processSauBlob(blob: SauBlobRow): Promise<void> {
  const previewText = blob.ocr_text || blob.preview_text || "";

  // SAU-aware metadata hints: pass the SAU name as defaultBoard hint so LLM
  // can fall back to it; no town field needed for SAU docs.
  let suggested: Awaited<ReturnType<typeof suggestMetadataFromPreview>>;
  try {
    suggested = await suggestMetadataFromPreview(
      blob.original_filename,
      previewText,
      {
        defaultTown: undefined, // SAU docs don't have a town
        defaultBoard: blob.sau_name, // e.g. "SAU 9 – Governor Wentworth"
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
  let versionId: string | null = null;

  if (!logicalDocId) {
    // Build a canonical title from extracted metadata
    const titleParts: string[] = [];
    if (suggested.board && suggested.board.length > 0) {
      titleParts.push(suggested.board);
    } else {
      titleParts.push(blob.sau_name);
    }
    if (suggested.meetingDate) {
      // Format as "Month YYYY" or just use raw date text
      try {
        const d = new Date(suggested.meetingDate);
        if (!isNaN(d.getTime())) {
          titleParts.push(d.toLocaleDateString("en-US", { month: "long", year: "numeric" }));
        }
      } catch {
        // ignore
      }
    } else if (suggested.year) {
      titleParts.push(suggested.year);
    }
    const canonicalTitle = titleParts.join(" — ");
    const board = (suggested.board && suggested.board.length > 0) ? suggested.board : blob.sau_name;
    const category = suggested.isMinutes ? "meeting_minutes" : (suggested.category || "misc_other");

    // Insert logical_document — town = 'unknown' for SAU docs
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

    if (!logicalDocId) {
      throw new Error(`Failed to create logical_document for blob ${blob.file_blob_id}`);
    }

    // Parse meeting date
    let meetingDate: Date | null = null;
    if (suggested.meetingDate) {
      try {
        const d = new Date(suggested.meetingDate);
        if (!isNaN(d.getTime())) meetingDate = d;
      } catch { /* ignore */ }
    }

    const yearStr = suggested.year || (meetingDate ? String(meetingDate.getFullYear()) : null);

    // Insert document_version
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
    versionId = (dvResult.rows as any[])[0]?.id as string;

    // Set current_version_id on logical_document
    if (versionId) {
      await db.execute(sql`
        UPDATE logical_documents
        SET current_version_id = ${versionId}, updated_at = NOW()
        WHERE id = ${logicalDocId}
      `);
    }

    logInfo(`[SauEnrich] Created logDoc=${logicalDocId} version=${versionId} for blob=${blob.file_blob_id}`);
  } else {
    // Get existing version id for chunk document_id update
    const dvResult = await db.execute(sql`
      SELECT id FROM document_versions
      WHERE file_blob_id = ${blob.file_blob_id}
      LIMIT 1
    `);
    versionId = (dvResult.rows as any[])[0]?.id ?? null;

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

    // Update version meeting_date if missing
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
  };

  if (suggested.board && suggested.board.length > 0) {
    chunkPatch.board = suggested.board;
  } else if (blob.sau_name) {
    chunkPatch.board = blob.sau_name;
  }

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

  if (logicalDocId) {
    chunkPatch.documentId = logicalDocId;
  }

  // Update chunk metadata + document_id
  const patchResult = await db.execute(sql`
    UPDATE document_chunks
    SET metadata = metadata || ${JSON.stringify(chunkPatch)}::jsonb,
        document_id = ${logicalDocId}
    WHERE file_blob_id = ${blob.file_blob_id}
  `);

  logInfo(
    `[SauEnrich] Patched ${patchResult.rowCount ?? 0} chunks for blob=${blob.file_blob_id} ` +
    `[board="${chunkPatch.board ?? ''}", type="${category}", date="${chunkPatch.meetingDate ?? ''}"]`
  );
}
