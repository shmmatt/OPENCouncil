
import { db, schema, eq, and } from "../storage/db";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import { Readable } from "stream";
import * as fs from "fs/promises";
import * as path from "path";
import { getOrCreateTownStore } from "./s3Sync"; 
import { processFile } from "./fileProcessing";
import { performOcrOnPdf } from "../workers/ocrWorkerUtils"; // New extracted utility

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

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

      if (analysis.needsOcr) {
        console.log(`[IngestWorker] OCR Needed for ${job.s3Key} (extracted ${analysis.extractedTextCharCount} chars)`);
        
        try {
            // Run Blocking OCR
            const ocrText = await performOcrOnPdf(tempPath);
            
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

      // 7. Unified Pipeline Linking
      await createUnifiedDocumentEntry(job, fileId, storeId, displayName, analysis, ocrPerformed);

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

// ... (Helper functions below: streamToBuffer, formatDisplayName, buildGeminiMetadata, createUnifiedDocumentEntry)
// I will include these in the full write, but updated to accept 'analysis' params
async function createUnifiedDocumentEntry(job: any, fileId: string, storeId: string, displayName: string, analysis: any, ocrPerformed: boolean) {
  // Logical Doc Logic
  const canonicalTitle = displayName;
  let logicalDoc = await db.query.logicalDocuments.findFirst({
    where: and(eq(schema.logicalDocuments.canonicalTitle, canonicalTitle), eq(schema.logicalDocuments.town, job.town))
  });

  if (!logicalDoc) {
    [logicalDoc] = await db.insert(schema.logicalDocuments).values({
      canonicalTitle, town: job.town, category: job.category || "uncategorized", board: job.board,
    }).returning();
  }

  // FileBlob Logic
  const s3Hash = `s3:${job.s3Key}`; 
  let fileBlob = await db.query.fileBlobs.findFirst({ where: eq(schema.fileBlobs.rawHash, s3Hash) });

  if (!fileBlob) {
    [fileBlob] = await db.insert(schema.fileBlobs).values({
      rawHash: s3Hash,
      sizeBytes: job.sizeBytes || 0,
      mimeType: "application/pdf",
      originalFilename: job.s3Key.split('/').pop() || "unknown.pdf",
      storagePath: `s3://${S3_BUCKET}/${job.s3Key}`,
      needsOcr: analysis.needsOcr,
      ocrStatus: ocrPerformed ? "completed" : (analysis.needsOcr ? "failed" : "none"), // We already tried
      extractedTextCharCount: analysis.extractedTextCharCount
    }).returning();
  }

  // Version Logic
  const [version] = await db.insert(schema.documentVersions).values({
    documentId: logicalDoc.id, fileBlobId: fileBlob.id, year: job.year,
    fileSearchStoreName: storeId, fileSearchDocumentName: fileId,
    isCurrent: true, isMinutes: job.category === "minutes",
    meetingDate: extractDateFromFilename(job.s3Key.split('/').pop() || "")
  }).returning();

  await db.update(schema.logicalDocuments).set({ currentVersionId: version.id }).where(eq(schema.logicalDocuments.id, logicalDoc.id));
}

function extractDateFromFilename(filename: string): Date | null {
  const match = filename.match(/(\d{4}[-_]\d{2}[-_]\d{2})|(\d{2}[-_]\d{2}[-_]\d{4})/);
  if (!match) return null;
  const dateStr = match[0].replace(/_/g, '-');
  const parts = dateStr.split('-');
  if (parts[0].length === 4) return new Date(dateStr);
  return new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
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
