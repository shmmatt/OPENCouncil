import { Worker, Job } from "bullmq";
import { connection } from "../config/redis";
import { db, schema, eq, and } from "../storage/db"; // Adjust import if needed
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import { Readable } from "stream";
import * as fs from "fs/promises";
import * as path from "path";
import { getOrCreateTownStore } from "../services/s3Sync"; 
import { processFile } from "../services/fileProcessing";
import { performOcrOnPdf } from "./ocrWorkerUtils"; 

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Cache for store IDs (in-memory per worker instance)
const storeCache = new Map<string, string>();

interface IngestionJobData {
  syncId: number;
}

export const ingestionWorker = new Worker<IngestionJobData>(
  "ingestion-queue",
  async (job: Job<IngestionJobData>) => {
    const { syncId } = job.data;
    console.log(`[IngestWorker] Processing Job ${job.id} (Sync ID: ${syncId})`);

    // 1. Fetch DB Record
    const syncRecord = await db.query.s3GeminiSync.findFirst({
      where: eq(schema.s3GeminiSync.id, syncId),
    });

    if (!syncRecord) {
      console.error(`[IngestWorker] Sync record ${syncId} not found.`);
      return; // Job done (failed silently as it's invalid)
    }

    if (syncRecord.status === "synced") {
      console.log(`[IngestWorker] Record ${syncId} already synced. Skipping.`);
      return;
    }

    // Update status to processing
    await db.update(schema.s3GeminiSync)
        .set({ status: "processing", errorMessage: null })
        .where(eq(schema.s3GeminiSync.id, syncId));

    let tempPath = "";
    let tempOcrPath = "";

    try {
      // 2. Get Store ID
      let storeId = storeCache.get(syncRecord.town);
      if (!storeId) {
        storeId = await getOrCreateTownStore(syncRecord.town);
        if (storeId) storeCache.set(syncRecord.town, storeId);
      }
      
      if (!storeId) throw new Error(`Could not resolve Store ID for town: ${syncRecord.town}`);

      // Update DB with correct store ID immediately
      if (syncRecord.geminiStoreId !== storeId) {
        await db.update(schema.s3GeminiSync)
          .set({ geminiStoreId: storeId })
          .where(eq(schema.s3GeminiSync.id, syncId));
      }

      // 3. Download from S3
      console.log(`[IngestWorker] Downloading ${syncRecord.s3Key}...`);
      const s3Stream = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: syncRecord.s3Key
      }));
      
      const buffer = await streamToBuffer(s3Stream.Body as Readable);
      tempPath = path.join("/tmp", `ingest_${syncRecord.id}_${Date.now()}.pdf`);
      await fs.writeFile(tempPath, buffer);

      // 4. Quality Check & OCR Decision
      const filename = syncRecord.s3Key.split('/').pop() || "doc.pdf";
      const analysis = await processFile(tempPath, filename);
      
      let uploadPath = tempPath;
      let ocrPerformed = false;

      if (analysis.needsOcr) {
        console.log(`[IngestWorker] OCR Needed for ${syncRecord.s3Key}`);
        try {
            const ocrText = await performOcrOnPdf(tempPath);
            tempOcrPath = path.join("/tmp", `ingest_${syncRecord.id}_ocr.txt`);
            
            const header = `DOCUMENT: ${syncRecord.s3Key}\nSOURCE: ${syncRecord.town} ${syncRecord.board} ${syncRecord.category}\n\n`;
            await fs.writeFile(tempOcrPath, header + ocrText);
            
            uploadPath = tempOcrPath;
            ocrPerformed = true;
        } catch (ocrErr: any) {
            console.error(`[IngestWorker] OCR Failed: ${ocrErr.message}. Falling back to PDF.`);
        }
      }

      // 5. Upload to Gemini
      console.log(`[IngestWorker] Uploading to Gemini Store ${storeId}...`);
      const displayName = formatDisplayName(syncRecord) + (ocrPerformed ? " (OCR)" : "");
      const customMetadata = buildGeminiMetadata(syncRecord);

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

      // 6. Update DB Success
      await db.update(schema.s3GeminiSync)
        .set({
          status: "synced",
          geminiDocumentId: fileId,
          syncedAt: new Date(),
          errorMessage: null
        })
        .where(eq(schema.s3GeminiSync.id, syncId));

      // 7. Unified Pipeline Linking
      await createUnifiedDocumentEntry(syncRecord, fileId, storeId, displayName, analysis, ocrPerformed);

      console.log(`[IngestWorker] Job ${job.id} Complete. Synced.`);

    } catch (err: any) {
      console.error(`[IngestWorker] Failed Job ${job.id}:`, err);
      
      // Update DB with error
      await db.update(schema.s3GeminiSync)
        .set({ status: "failed", errorMessage: err.message.substring(0, 500) })
        .where(eq(schema.s3GeminiSync.id, syncId));
      
      throw err; // Trigger BullMQ retry
    } finally {
      // Cleanup
      if (tempPath) await fs.unlink(tempPath).catch(() => {});
      if (tempOcrPath) await fs.unlink(tempOcrPath).catch(() => {});
    }
  },
  {
    connection,
    concurrency: 5, // Process 5 files at once
  }
);

// --- Helpers ---

async function createUnifiedDocumentEntry(job: any, fileId: string, storeId: string, displayName: string, analysis: any, ocrPerformed: boolean) {
  // 1. Logical Document
  const canonicalTitle = displayName;
  let logicalDoc = await db.query.logicalDocuments.findFirst({
    where: and(eq(schema.logicalDocuments.canonicalTitle, canonicalTitle), eq(schema.logicalDocuments.town, job.town))
  });

  if (!logicalDoc) {
    [logicalDoc] = await db.insert(schema.logicalDocuments).values({
      canonicalTitle, town: job.town, category: job.category || "uncategorized", board: job.board,
    }).returning();
  }

  // 2. File Blob (Check by Hash)
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
      ocrStatus: ocrPerformed ? "completed" : (analysis.needsOcr ? "failed" : "none"),
      extractedTextCharCount: analysis.extractedTextCharCount
    }).returning();
  }

  // 3. Document Version
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
