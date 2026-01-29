/**
 * S3 to Gemini File Search Sync Service
 * 
 * Syncs documents from S3 to town-specific Gemini File Search stores
 * with database tracking to avoid re-uploading.
 * 
 * Uses the existing store for Conway: fileSearchStores/opencouncil-conway-1knojndjgr4v
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import * as fs from "fs/promises";
import * as path from "path";
import { Readable } from "stream";
import * as syncStorage from "../storage/s3GeminiSync";
import type { InsertS3GeminiSync, S3GeminiSync } from "@shared/schema";

// ============================================================
// CONFIGURATION
// ============================================================

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const S3_REGION = process.env.AWS_REGION || "us-east-1";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const s3 = new S3Client({ region: S3_REGION });

// Town store mapping - pre-configured stores
const TOWN_STORES: Record<string, string> = {
  conway: "fileSearchStores/opencouncil-conway-1knojndjgr4v",
  // Add more towns as needed
};

// ============================================================
// TYPES
// ============================================================

export interface S3File {
  key: string;
  size: number;
  lastModified: Date;
}

export interface ExtractedMetadata {
  town: string;
  category: string;
  board?: string;
  year?: string;
  isMinutes: boolean;
  meetingDate?: string;
  filename: string;
}

export interface SyncStatus {
  town: string;
  storeId: string;
  s3Total: number;
  dbTotal: number;
  synced: number;
  pending: number;
  failed: number;
}

export interface SyncResult {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  errors: Array<{ key: string; error: string }>;
}

export interface SyncOptions {
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
}

// ============================================================
// STORE MANAGEMENT
// ============================================================

export function getTownStoreId(town: string): string | null {
  return TOWN_STORES[town.toLowerCase()] || null;
}

export async function getOrCreateTownStore(town: string): Promise<string> {
  const existing = TOWN_STORES[town.toLowerCase()];
  if (existing) return existing;
  
  // Create new store
  const displayName = `OPENCouncil - ${capitalizeFirst(town)}`;
  
  try {
    const store = await ai.fileSearchStores.create({
      config: { displayName },
    });
    
    const storeId = store.name || "";
    if (storeId) {
      TOWN_STORES[town.toLowerCase()] = storeId;
      console.log(`[S3GeminiSync] Created store for ${town}: ${storeId}`);
      return storeId;
    }
    
    throw new Error(`Failed to create store for ${town}`);
  } catch (error) {
    console.error(`[S3GeminiSync] Error creating store for ${town}:`, error);
    throw error;
  }
}

// ============================================================
// S3 OPERATIONS
// ============================================================

/**
 * List all PDF files for a town from S3
 */
export async function listS3Town(town: string): Promise<S3File[]> {
  const prefix = `${town.toLowerCase()}/`;
  const files: S3File[] = [];
  let continuationToken: string | undefined;
  
  do {
    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    
    const response = await s3.send(command);
    
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && obj.Size && obj.LastModified) {
          if (obj.Key.toLowerCase().endsWith(".pdf")) {
            files.push({
              key: obj.Key,
              size: obj.Size,
              lastModified: obj.LastModified,
            });
          }
        }
      }
    }
    
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  
  return files;
}

async function downloadS3File(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  });
  
  const response = await s3.send(command);
  
  if (!response.Body) {
    throw new Error(`Empty response body for ${key}`);
  }
  
  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];
  
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ============================================================
// METADATA EXTRACTION
// ============================================================

/**
 * Extract metadata from S3 key path.
 * Expected patterns:
 *   town/minutes/Board_Name/YYYY/filename.pdf
 *   town/category/filename.pdf
 */
export function extractMetadataFromPath(s3Key: string): ExtractedMetadata {
  const parts = s3Key.split("/").filter(Boolean);
  
  if (parts.length < 2) {
    throw new Error(`Invalid S3 key structure: ${s3Key}`);
  }
  
  const town = parts[0].toLowerCase();
  const category = parts[1].toLowerCase();
  const filename = parts[parts.length - 1];
  
  const result: ExtractedMetadata = {
    town,
    category,
    filename,
    isMinutes: category === "minutes",
  };
  
  // Extract board and year from minutes paths
  if (category === "minutes" && parts.length >= 4) {
    result.board = parts[2].replace(/_/g, " ");
    
    const possibleYear = parts[3];
    if (/^\d{4}/.test(possibleYear)) {
      result.year = possibleYear.substring(0, 4);
    }
  }
  
  // Try to extract meeting date from filename
  const dateMatch = filename.match(/(\d{1,2}[-_]\d{1,2}[-_]\d{2,4})|(\d{4}[-_]\d{1,2}[-_]\d{1,2})/);
  if (dateMatch) {
    result.meetingDate = normalizeDateString(dateMatch[0]);
  }
  
  return result;
}

function normalizeDateString(dateStr: string): string {
  const cleaned = dateStr.replace(/_/g, "-");
  const parts = cleaned.split("-");
  
  if (parts.length !== 3) return dateStr;
  
  if (parts[0].length === 4) {
    return cleaned;
  }
  
  let year = parts[2];
  if (year.length === 2) {
    year = parseInt(year) > 50 ? `19${year}` : `20${year}`;
  }
  
  return `${year}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================================
// SYNC STATUS
// ============================================================

/**
 * Get sync status for a town
 */
export async function getSyncStatus(town: string): Promise<SyncStatus> {
  const townLower = town.toLowerCase();
  const storeId = getTownStoreId(townLower) || "not_configured";
  
  // Get S3 count
  const s3Files = await listS3Town(townLower);
  const s3Total = s3Files.length;
  
  // Get DB stats
  const dbStats = await syncStorage.getSyncStats(townLower);
  
  return {
    town: townLower,
    storeId,
    s3Total,
    dbTotal: dbStats.total,
    synced: dbStats.synced,
    pending: dbStats.pending,
    failed: dbStats.failed,
  };
}

// ============================================================
// GEMINI UPLOAD
// ============================================================

async function uploadToGemini(
  fileBuffer: Buffer,
  metadata: ExtractedMetadata,
  storeId: string
): Promise<{ success: boolean; documentId?: string; error?: string }> {
  const tempDir = path.join("/tmp", "s3gemini");
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${Date.now()}_${metadata.filename}`);
  
  try {
    await fs.writeFile(tempPath, fileBuffer);
    
    // Build display name
    const displayParts: string[] = [];
    if (metadata.town) displayParts.push(capitalizeFirst(metadata.town));
    if (metadata.board) displayParts.push(metadata.board);
    if (metadata.meetingDate) displayParts.push(`Meeting ${metadata.meetingDate}`);
    else if (metadata.year) displayParts.push(metadata.year);
    
    const displayName = displayParts.length > 0 
      ? `[${displayParts.join(" - ")}] ${metadata.filename}`
      : metadata.filename;
    
    // Build custom metadata
    const customMetadata: Array<{ key: string; stringValue: string }> = [
      { key: "category", stringValue: metadata.isMinutes ? "meeting_minutes" : metadata.category },
      { key: "town", stringValue: metadata.town },
      { key: "source", stringValue: "s3_sync" },
    ];
    
    if (metadata.board) {
      customMetadata.push({ key: "board", stringValue: metadata.board });
    }
    if (metadata.year) {
      customMetadata.push({ key: "year", stringValue: metadata.year });
    }
    if (metadata.isMinutes) {
      customMetadata.push({ key: "isMinutes", stringValue: "true" });
    }
    if (metadata.meetingDate) {
      customMetadata.push({ key: "meetingDate", stringValue: metadata.meetingDate });
    }
    
    // Upload to Gemini
    const operation = await ai.fileSearchStores.uploadToFileSearchStore({
      file: tempPath,
      fileSearchStoreName: storeId,
      config: {
        displayName,
        mimeType: "application/pdf",
        customMetadata,
        chunkingConfig: {
          whiteSpaceConfig: {
            maxTokensPerChunk: 200,
            maxOverlapTokens: 20,
          },
        },
      },
    });
    
    const opResponse = operation as any;
    const documentId = opResponse.response?.documentName 
                    || opResponse.documentName
                    || opResponse.response?.files?.[0]?.name;
    
    if (!documentId) {
      throw new Error("Failed to extract document ID from response");
    }
    
    return { success: true, documentId };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMsg };
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

// ============================================================
// SYNC ORCHESTRATION
// ============================================================

/**
 * Sync a town's files from S3 to Gemini with DB tracking
 */
export async function syncTown(
  town: string, 
  options: SyncOptions = {}
): Promise<SyncResult> {
  const { limit, concurrency = 3, dryRun = false } = options;
  const townLower = town.toLowerCase();
  
  console.log(`[S3GeminiSync] Starting sync for ${townLower}...`);
  
  // Get or create store
  const storeId = await getOrCreateTownStore(townLower);
  console.log(`[S3GeminiSync] Using store: ${storeId}`);
  
  // Get S3 files
  const s3Files = await listS3Town(townLower);
  console.log(`[S3GeminiSync] Found ${s3Files.length} PDFs in S3`);
  
  // Get already synced keys
  const syncedKeys = await syncStorage.getSyncedS3Keys(townLower);
  console.log(`[S3GeminiSync] Already synced: ${syncedKeys.size} files`);
  
  // Filter to pending files
  const pendingFiles = s3Files.filter(f => !syncedKeys.has(f.key));
  const filesToSync = limit ? pendingFiles.slice(0, limit) : pendingFiles;
  
  console.log(`[S3GeminiSync] Files to sync: ${filesToSync.length}`);
  
  if (dryRun) {
    console.log(`[S3GeminiSync] DRY RUN - would sync:`);
    for (const file of filesToSync.slice(0, 10)) {
      console.log(`  ${file.key}`);
    }
    if (filesToSync.length > 10) {
      console.log(`  ... and ${filesToSync.length - 10} more`);
    }
    return {
      total: filesToSync.length,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };
  }
  
  const result: SyncResult = {
    total: filesToSync.length,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  
  // Process in batches
  for (let i = 0; i < filesToSync.length; i += concurrency) {
    const batch = filesToSync.slice(i, i + concurrency);
    
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        try {
          const metadata = extractMetadataFromPath(file.key);
          
          // Create or get sync record
          const syncRecord = await syncStorage.getOrCreateSyncRecord(file.key, {
            geminiStoreId: storeId,
            town: townLower,
            category: metadata.isMinutes ? "meeting_minutes" : metadata.category,
            board: metadata.board,
            year: metadata.year,
            sizeBytes: file.size,
            status: 'pending',
          });
          
          // Skip if already synced
          if (syncRecord.status === 'synced') {
            console.log(`[S3GeminiSync] ⏭ ${file.key} (already synced)`);
            return { success: true, skipped: true };
          }
          
          // Download and upload
          const fileBuffer = await downloadS3File(file.key);
          const uploadResult = await uploadToGemini(fileBuffer, metadata, storeId);
          
          if (uploadResult.success && uploadResult.documentId) {
            await syncStorage.markSynced(syncRecord.id, uploadResult.documentId);
            console.log(`[S3GeminiSync] ✓ ${file.key}`);
            return { success: true, skipped: false };
          } else {
            await syncStorage.markFailed(syncRecord.id, uploadResult.error || "Unknown error");
            throw new Error(uploadResult.error || "Upload failed");
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[S3GeminiSync] ✗ ${file.key}: ${errorMsg}`);
          return { success: false, key: file.key, error: errorMsg };
        }
      })
    );
    
    for (const r of batchResults) {
      if (r.success) {
        if ((r as any).skipped) {
          result.skipped++;
        } else {
          result.uploaded++;
        }
      } else {
        result.failed++;
        result.errors.push({ key: (r as any).key!, error: (r as any).error! });
      }
    }
    
    // Progress update
    const processed = i + batch.length;
    if (processed % 10 === 0 || processed === filesToSync.length) {
      console.log(`[S3GeminiSync] Progress: ${processed}/${filesToSync.length} (${result.uploaded} uploaded, ${result.failed} failed)`);
    }
    
    // Rate limit delay
    if (i + concurrency < filesToSync.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  console.log(`[S3GeminiSync] Complete: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.failed} failed`);
  return result;
}
