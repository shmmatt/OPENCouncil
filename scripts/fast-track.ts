
import { db, schema, eq, and } from "../server/storage/db";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import { Readable } from "stream";
import * as fs from "fs/promises";
import * as path from "path";
import { getOrCreateTownStore } from "../server/services/s3Sync";
import { processFile } from "../server/services/fileProcessing";

// Config
const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Cache
const storeCache = new Map<string, string>();

async function fastTrack() {
  console.log("[FastTrack] Starting analysis of PENDING files...");
  
  // Get all pending jobs
  const jobs = await db.query.s3GeminiSync.findMany({
    where: eq(schema.s3GeminiSync.status, "pending"),
    limit: 5000 // Grab a big batch
  });

  console.log(`[FastTrack] Found ${jobs.length} pending files.`);
  
  let processed = 0;
  let skippedForOcr = 0;
  let errors = 0;

  for (const job of jobs) {
    const tempPath = path.join("/tmp", `fast_${job.id}.pdf`);
    
    try {
      // 1. Download
      const s3Stream = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: job.s3Key
      }));
      const buffer = await streamToBuffer(s3Stream.Body as Readable);
      await fs.writeFile(tempPath, buffer);

      // 2. Analyze Text
      const analysis = await processFile(tempPath, job.s3Key.split('/').pop() || "doc.pdf");
      
      // 3. Decision
      if (analysis.needsOcr) {
        console.log(`[FastTrack] SKIP: ${job.s3Key} needs OCR (${analysis.extractedTextCharCount} chars).`);
        skippedForOcr++;
        // We leave it as 'pending' so the heavy worker can pick it up later
        // OR we mark it 'pending_ocr' if we want to differentiate
      } else {
        console.log(`[FastTrack] SYNC: ${job.s3Key} has text (${analysis.extractedTextCharCount} chars). Uploading...`);
        
        // 4. Upload & Sync (Immediate)
        let storeId = storeCache.get(job.town);
        if (!storeId) {
            storeId = await getOrCreateTownStore(job.town);
            storeCache.set(job.town, storeId);
        }

        const displayName = formatDisplayName(job);
        const customMetadata = buildGeminiMetadata(job);

        const uploadOp = await ai.fileSearchStores.uploadToFileSearchStore({
            file: tempPath,
            fileSearchStoreName: storeId,
            config: {
                displayName,
                mimeType: "application/pdf",
                customMetadata,
            }
        });
        
        const response = uploadOp as any;
        const fileId = response.response?.documentName || response.documentName || response.response?.files?.[0]?.name;

        if (!fileId) throw new Error("No file ID from Gemini");

        // Update DB
        await db.update(schema.s3GeminiSync)
            .set({
                status: "synced",
                geminiDocumentId: fileId,
                syncedAt: new Date(),
                errorMessage: null
            })
            .where(eq(schema.s3GeminiSync.id, job.id));
            
        // Unified Entry
        await createUnifiedDocumentEntry(job, fileId, storeId, displayName, analysis);
        processed++;
      }

    } catch (err) {
      console.error(`[FastTrack] Error on ${job.s3Key}:`, err.message);
      errors++;
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  console.log("\n=== FastTrack Complete ===");
  console.log(`Synced (Text): ${processed}`);
  console.log(`Skipped (Needs OCR): ${skippedForOcr}`);
  console.log(`Errors: ${errors}`);
}

// Helpers (Copied from worker to keep script standalone)
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
  return parts.length > 0 ? `[${parts.join(" - ")}] ${job.s3Key.split('/').pop()}` : job.s3Key.split('/').pop();
}

function buildGeminiMetadata(job: any) {
  const meta: any = [{ key: "town", stringValue: job.town }, { key: "source", stringValue: "s3_sync" }];
  if (job.category) meta.push({ key: "category", stringValue: job.category });
  if (job.board) meta.push({ key: "board", stringValue: job.board });
  if (job.year) meta.push({ key: "year", stringValue: job.year });
  return meta;
}

function extractDateFromFilename(filename: string): Date | null {
  const match = filename.match(/(\d{4}[-_]\d{2}[-_]\d{2})|(\d{2}[-_]\d{2}[-_]\d{4})/);
  if (!match) return null;
  const dateStr = match[0].replace(/_/g, '-');
  const parts = dateStr.split('-');
  if (parts[0].length === 4) return new Date(dateStr);
  return new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
}

async function createUnifiedDocumentEntry(job: any, fileId: string, storeId: string, displayName: string, analysis: any) {
  const canonicalTitle = displayName;
  let logicalDoc = await db.query.logicalDocuments.findFirst({
    where: and(eq(schema.logicalDocuments.canonicalTitle, canonicalTitle), eq(schema.logicalDocuments.town, job.town))
  });

  if (!logicalDoc) {
    [logicalDoc] = await db.insert(schema.logicalDocuments).values({
      canonicalTitle, town: job.town, category: job.category || "uncategorized", board: job.board,
    }).returning();
  }

  const s3Hash = `s3:${job.s3Key}`; 
  let fileBlob = await db.query.fileBlobs.findFirst({ where: eq(schema.fileBlobs.rawHash, s3Hash) });

  if (!fileBlob) {
    [fileBlob] = await db.insert(schema.fileBlobs).values({
      rawHash: s3Hash,
      sizeBytes: job.sizeBytes || 0,
      mimeType: "application/pdf",
      originalFilename: job.s3Key.split('/').pop() || "unknown.pdf",
      storagePath: `s3://${S3_BUCKET}/${job.s3Key}`,
      needsOcr: false,
      ocrStatus: "none",
      extractedTextCharCount: analysis.extractedTextCharCount
    }).returning();
  }

  const [version] = await db.insert(schema.documentVersions).values({
    documentId: logicalDoc.id, fileBlobId: fileBlob.id, year: job.year,
    fileSearchStoreName: storeId, fileSearchDocumentName: fileId,
    isCurrent: true, isMinutes: job.category === "minutes",
    meetingDate: extractDateFromFilename(job.s3Key.split('/').pop() || "")
  }).returning();

  await db.update(schema.logicalDocuments).set({ currentVersionId: version.id }).where(eq(schema.logicalDocuments.id, logicalDoc.id));
}

fastTrack().catch(console.error);
