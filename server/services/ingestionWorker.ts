
import { db, schema, eq, and } from "../storage/db";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import { Readable } from "stream";
import * as fs from "fs/promises";
import * as path from "path";
import { getOrCreateTownStore } from "./s3Sync"; 
import { processFile } from "./fileProcessing";
import { performOcrOnPdf } from "../workers/ocrWorkerUtils";
import { suggestMetadataFromPreview, parseDateToISO } from "./metadataExtraction";

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });

// Cache for store IDs
const storeCache = new Map<string, string>();

/**
 * Worker function to process 'pending' files
 */
export async function processPendingFiles(limit = 1) {
  // Use env var override or default to 1 (safe mode)
  const safeLimit = process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE) : 1;
  
  const jobs = await db.query.s3GeminiSync.findMany({
    where: eq(schema.s3GeminiSync.status, "pending"),
    limit: safeLimit
  });

  if (jobs.length === 0) return { processed: 0, errors: 0 };

  console.log(`[IngestWorker] Processing ${jobs.length} files...`);
  let successCount = 0;
  let errorCount = 0;

  for (const job of jobs) {
    let tempPath = "";
    try {
      // 1. Get Store ID
      let storeId = storeCache.get(job.town);
      if (!storeId) {
        storeId = await getOrCreateTownStore(job.town);
        storeCache.set(job.town, storeId);
      }
      
      // Update DB with correct store ID immediately
      if (job.geminiStoreId.startsWith("pending")) {
        await db.update(schema.s3GeminiSync)
          .set({ geminiStoreId: storeId })
          .where(eq(schema.s3GeminiSync.id, job.id));
      }

      // 2. Download from S3
      const s3Stream = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: job.s3Key
      }));
      const buffer = await streamToBuffer(s3Stream.Body as Readable);

      // 3. Write to temp file
      tempPath = path.join("/tmp", `ingest_${job.id}.pdf`);
      await fs.writeFile(tempPath, buffer);

      // 4. Quality Check & OCR Decision
      const analysis = await processFile(tempPath, job.s3Key.split('/').pop() || "doc.pdf");
      
      let uploadPath = tempPath;
      let ocrPerformed = false;
      let tempOcrPath = "";
      // ocrExtractedText holds the raw OCR output for metadata enrichment (best available text)
      let ocrExtractedText: string | null = null;

      if (analysis.needsOcr) {
        console.log(`[IngestWorker] OCR Needed for ${job.s3Key} (extracted ${analysis.extractedTextCharCount} chars)`);
        
        try {
            // Run Blocking OCR
            const ocrText = await performOcrOnPdf(tempPath);
            ocrExtractedText = ocrText;
            
            // Write to a .txt file for upload (Gemini handles txt fine and it's cleaner than rebuilding a PDF)
            tempOcrPath = path.join("/tmp", `ingest_${job.id}_ocr.txt`);
            
            // Header to give context to the LLM
            const header = `DOCUMENT: ${job.s3Key}\nSOURCE: ${job.town} ${job.board} ${job.category}\n\n`;
            await fs.writeFile(tempOcrPath, header + ocrText);
            
            uploadPath = tempOcrPath;
            ocrPerformed = true;
            console.log(`[IngestWorker] OCR Complete. Uploading text file.`);
        } catch (ocrErr) {
            console.error(`[IngestWorker] OCR Failed: ${ocrErr.message}. Falling back to raw PDF.`);
            // Fallback: Upload original PDF even if OCR failed
        }
      }

      // 5. Upload to Gemini (either PDF or OCR'd Text)
      const displayName = formatDisplayName(job) + (ocrPerformed ? " (OCR)" : "");
      const customMetadata = buildGeminiMetadata(job);

      const uploadOp = await ai.fileSearchStores.uploadToFileSearchStore({
        file: uploadPath,
        fileSearchStoreName: storeId,
        config: {
          displayName,
          mimeType: ocrPerformed ? "text/plain" : "application/pdf",
          customMetadata,
        }
      });
      
      const response = uploadOp as any;
      const fileId = response.response?.documentName 
                  || response.documentName 
                  || response.response?.files?.[0]?.name;

      if (!fileId) throw new Error("No file ID returned from Gemini");

      // 6. Update DB Success (s3_gemini_sync)
      await db.update(schema.s3GeminiSync)
        .set({
          status: "synced",
          geminiDocumentId: fileId,
          syncedAt: new Date(),
          errorMessage: null
        })
        .where(eq(schema.s3GeminiSync.id, job.id));

      // 7. Unified Pipeline Linking (pass OCR text so LLM enrichment uses the best available text)
      await createUnifiedDocumentEntry(job, fileId, storeId, displayName, analysis, ocrPerformed, ocrExtractedText);

      // Cleanup
      await fs.unlink(tempPath).catch(() => {});
      if (tempOcrPath) await fs.unlink(tempOcrPath).catch(() => {});
      
      successCount++;
      console.log(`[IngestWorker] Synced: ${job.s3Key}`);

    } catch (err: any) {
      console.error(`[IngestWorker] Failed ${job.s3Key}:`, err.message);
      errorCount++;
      await db.update(schema.s3GeminiSync)
        .set({ status: "failed", errorMessage: err.message.substring(0, 500) })
        .where(eq(schema.s3GeminiSync.id, job.id));
        
      // Cleanup on error
      if (tempPath) await fs.unlink(tempPath).catch(() => {});
    }
  }

  return { processed: successCount, errors: errorCount };
}

/**
 * Determines whether a Gemini LLM enrichment call is needed for this job.
 * Returns true when the filename-based date is missing or the board is unresolved.
 * The weak-board set must match the backfill script so that the same cases trigger enrichment.
 */
function needsLlmEnrichment(baselineMeetingDate: Date | null, board: string | null | undefined): boolean {
  const weakBoards = new Set([
    "unknown board", "unknown", "", "uncategorized", "none", "needs review",
  ]);
  const boardIsWeak = !board || weakBoards.has(board.toLowerCase().trim());
  return !baselineMeetingDate || boardIsWeak;
}

async function createUnifiedDocumentEntry(
  job: any,
  fileId: string,
  storeId: string,
  displayName: string,
  analysis: any,
  ocrPerformed: boolean,
  ocrExtractedText: string | null
) {
  const filename = job.s3Key.split('/').pop() || "unknown.pdf";

  // --- Baseline metadata from the filename (cheap, no I/O) ---
  let meetingDate: Date | null = extractDateFromFilename(filename);
  let resolvedBoard: string = job.board || "Unknown Board";
  // Normalize "minutes" (legacy crawler value) to the canonical DB category "meeting_minutes"
  const rawCategory = job.category || "uncategorized";
  let resolvedCategory: string = rawCategory === "minutes" ? "meeting_minutes" : rawCategory;
  let isMinutes: boolean = rawCategory === "minutes" || rawCategory === "meeting_minutes";
  let meetingType: string | null = null;

  // --- LLM enrichment: only fire when baseline is insufficient ---
  if (needsLlmEnrichment(meetingDate, resolvedBoard)) {
    try {
      // Prefer OCR text (richer, from scanned docs) over the pdf-parse preview when available.
      // For native-text PDFs, analysis.previewText is used.
      const previewText = ocrExtractedText || analysis.previewText || "";

      const suggested = await suggestMetadataFromPreview(
        filename,
        previewText,
        { defaultTown: job.town || undefined, defaultBoard: job.board || undefined }
      );

      console.log(
        `[IngestWorker] LLM enrichment for ${filename}: ` +
        `date=${suggested.meetingDate || "none"}, board="${suggested.board}", ` +
        `meetingType=${suggested.meetingType || "none"}, isMinutes=${suggested.isMinutes}, ` +
        `category=${suggested.category}`
      );

      // Use LLM date only if we didn't get one from the filename.
      // Use parseDateToISO for consistent normalization (same as backfill + metadata service).
      if (!meetingDate && suggested.meetingDate) {
        const isoStr = parseDateToISO(suggested.meetingDate) || suggested.meetingDate;
        const parsed = new Date(isoStr);
        if (!isNaN(parsed.getTime())) {
          meetingDate = parsed;
        }
      }

      // Upgrade board only when baseline board is weak AND LLM returned something specific.
      // This prevents overwriting a known board name with a potentially hallucinated one.
      const weakBoards = new Set([
        "unknown board", "unknown", "", "uncategorized", "none", "needs review",
      ]);
      const baselineIsWeak = weakBoards.has(resolvedBoard.toLowerCase().trim());
      if (baselineIsWeak && suggested.board && !weakBoards.has(suggested.board.toLowerCase().trim())) {
        resolvedBoard = suggested.board;
      }

      // Apply isMinutes from LLM when it returns a definitive boolean.
      // Keep category consistent with isMinutes.
      if (typeof suggested.isMinutes === "boolean") {
        isMinutes = suggested.isMinutes;
        if (isMinutes) {
          resolvedCategory = "meeting_minutes";
        } else if (suggested.category && suggested.category !== "misc_other") {
          resolvedCategory = suggested.category;
        }
      } else if (suggested.category && suggested.category !== "misc_other") {
        resolvedCategory = suggested.category;
      }

      // Capture meetingType from LLM (stored in notes since there's no dedicated DB column)
      if (suggested.meetingType) {
        meetingType = suggested.meetingType;
      }
    } catch (llmErr: unknown) {
      // LLM failure must never crash the worker or drop the document.
      // Log and continue with whatever baseline metadata we already have.
      const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.error(
        `[IngestWorker] LLM enrichment failed for ${filename} (continuing with baseline): ${msg.substring(0, 200)}`
      );
    }
  }

  // --- Logical Doc ---
  const canonicalTitle = displayName;
  let logicalDoc = await db.query.logicalDocuments.findFirst({
    where: and(
      eq(schema.logicalDocuments.canonicalTitle, canonicalTitle),
      eq(schema.logicalDocuments.town, job.town)
    )
  });

  if (!logicalDoc) {
    [logicalDoc] = await db.insert(schema.logicalDocuments).values({
      canonicalTitle,
      town: job.town,
      category: resolvedCategory,
      board: resolvedBoard,
    }).returning();
  } else {
    // Existing logical doc found — opportunistically upgrade weak board/category
    const existingBoardIsWeak = !logicalDoc.board ||
      new Set(["unknown board", "unknown", "", "uncategorized", "none", "needs review"])
        .has(logicalDoc.board.toLowerCase().trim());
    const existingCategoryIsWeak = !logicalDoc.category || logicalDoc.category === "uncategorized";
    const updates: Record<string, unknown> = {};
    if (existingBoardIsWeak && resolvedBoard && resolvedBoard !== "Unknown Board") {
      updates.board = resolvedBoard;
    }
    if (existingCategoryIsWeak && resolvedCategory && resolvedCategory !== "uncategorized") {
      updates.category = resolvedCategory;
    }
    if (Object.keys(updates).length > 0) {
      console.log(`[IngestWorker] Upgrading existing logical doc ${logicalDoc.id}: ${JSON.stringify(updates)}`);
      await db.update(schema.logicalDocuments).set(updates).where(eq(schema.logicalDocuments.id, logicalDoc.id));
      logicalDoc = { ...logicalDoc, ...updates } as typeof logicalDoc;
    }
  }

  // --- FileBlob ---
  const s3Hash = `s3:${job.s3Key}`; 
  let fileBlob = await db.query.fileBlobs.findFirst({ where: eq(schema.fileBlobs.rawHash, s3Hash) });

  if (!fileBlob) {
    [fileBlob] = await db.insert(schema.fileBlobs).values({
      rawHash: s3Hash,
      sizeBytes: job.sizeBytes || 0,
      mimeType: "application/pdf",
      originalFilename: filename,
      storagePath: `s3://${S3_BUCKET}/${job.s3Key}`,
      needsOcr: analysis.needsOcr,
      ocrStatus: ocrPerformed ? "completed" : (analysis.needsOcr ? "failed" : "none"),
      extractedTextCharCount: analysis.extractedTextCharCount
    }).returning();
  }

  // --- Document Version ---
  // meetingType has no dedicated DB column; store it in notes so it is not silently lost.
  const versionNotes = meetingType ? `meetingType:${meetingType}` : undefined;

  const [version] = await db.insert(schema.documentVersions).values({
    documentId: logicalDoc.id,
    fileBlobId: fileBlob.id,
    year: job.year || (meetingDate ? String(meetingDate.getFullYear()) : undefined),
    notes: versionNotes,
    fileSearchStoreName: storeId,
    fileSearchDocumentName: fileId,
    isCurrent: true,
    isMinutes,
    meetingDate,
  }).returning();

  await db
    .update(schema.logicalDocuments)
    .set({ currentVersionId: version.id })
    .where(eq(schema.logicalDocuments.id, logicalDoc.id));
}

function extractDateFromFilename(filename: string): Date | null {
  // YYYY-MM-DD or YYYY_MM_DD
  const m1 = filename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (m1) {
    const d = new Date(`${m1[1]}-${m1[2]}-${m1[3]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
  }

  // MM-DD-YYYY or MM_DD_YYYY
  const m2 = filename.match(/(\d{2})[-_](\d{2})[-_](\d{4})/);
  if (m2) {
    const d = new Date(`${m2[3]}-${m2[1]}-${m2[2]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2035) return d;
  }

  return null;
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function formatDisplayName(job: any): string {
  const parts = [];
  if (job.town) parts.push(job.town.charAt(0).toUpperCase() + job.town.slice(1));
  if (job.board) parts.push(job.board);
  if (job.year) parts.push(job.year);
  const filename = job.s3Key.split('/').pop();
  return parts.length > 0 ? `[${parts.join(" - ")}] ${filename}` : filename;
}

function buildGeminiMetadata(job: any) {
  const meta: any = [{ key: "town", stringValue: job.town }, { key: "source", stringValue: "s3_sync" }];
  if (job.category) meta.push({ key: "category", stringValue: job.category });
  if (job.board) meta.push({ key: "board", stringValue: job.board });
  if (job.year) meta.push({ key: "year", stringValue: job.year });
  return meta;
}
