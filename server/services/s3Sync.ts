/**
 * S3 to Gemini File Search Sync Service
 * 
 * Pulls documents from S3, extracts metadata from paths, and uploads to 
 * town-specific Gemini File Search stores.
 * 
 * Architecture (Option A):
 * - Existing store: "statewide + legacy" (RSAs, regs, existing Ossipee/GWRSD)
 * - New per-town stores: conway, ossipee, etc.
 * 
 * S3 path convention:
 *   s3://bucket/town/category/[board/][year/]filename.pdf
 *   e.g., s3://opencouncil-municipal-docs/conway/minutes/Board_of_Selectmen/2024/file.pdf
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import * as fs from "fs/promises";
import * as path from "path";
import { Readable } from "stream";

// ============================================================
// CONFIGURATION
// ============================================================

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const S3_REGION = process.env.AWS_REGION || "us-east-1";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const s3 = new S3Client({ region: S3_REGION });

// Store IDs cache: town -> storeId
const townStores: Map<string, string> = new Map();

// ============================================================
// STORE MANAGEMENT
// ============================================================

export async function getOrCreateTownStore(town: string): Promise<string> {
  // Check cache
  const cached = townStores.get(town);
  if (cached) return cached;
  
  // TODO: Check database for existing store ID
  // For now, create new store
  const displayName = `OPENCouncil - ${capitalizeFirst(town)}`;
  
  try {
    const store = await ai.fileSearchStores.create({
      config: { displayName },
    });
    
    const storeId = store.name || "";
    if (storeId) {
      townStores.set(town, storeId);
      console.log(`[S3Sync] Created store for ${town}: ${storeId}`);
      return storeId;
    }
    
    throw new Error(`Failed to create store for ${town}`);
  } catch (error) {
    console.error(`[S3Sync] Error creating store for ${town}:`, error);
    throw error;
  }
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================================
// METADATA EXTRACTION
// ============================================================

export interface ExtractedMetadata {
  town: string;
  category: string;
  board?: string;
  year?: string;
  isMinutes: boolean;
  meetingDate?: string;
  filename: string;
}

/**
 * Extract metadata from S3 key path.
 * Supports both structured paths and flat/messy scraper paths.
 */
export function extractMetadataFromPath(s3Key: string): ExtractedMetadata {
  const parts = s3Key.split("/").filter(Boolean);
  
  if (parts.length < 2) {
    throw new Error(`Invalid S3 key structure: ${s3Key}`);
  }
  
  const town = parts[0].toLowerCase();
  const filename = parts[parts.length - 1];
  
  // Defaults
  let category = "document";
  let board: string | undefined;
  let year: string | undefined;
  
  // --- Strategy 1: Structured Path (town/category/board/year/file) ---
  // If we have a deep structure (>= 4 parts) and the category looks valid
  if (parts.length >= 4 && ["minutes", "agendas", "budgets"].includes(parts[1].toLowerCase())) {
    category = parts[1].toLowerCase();
    board = parts[2].replace(/_/g, " ");
    const possibleYear = parts[3];
    if (/^\d{4}/.test(possibleYear)) {
      year = possibleYear.substring(0, 4);
    }
  } 
  // --- Strategy 2: Flat/Messy Path (Scraper Output) ---
  else {
    // Attempt to extract from filename
    
    // 1. Year detection (YYYY)
    const yearMatch = filename.match(/(19|20)\d{2}/);
    if (yearMatch) {
      year = yearMatch[0];
    }
    
    // 2. Board detection
    board = detectBoardFromFilename(filename);
    
    // 3. Category detection
    category = detectCategoryFromFilename(filename);
  }

  // --- Common Logic ---
  
  // Try to extract meeting date from filename (stronger signal than folder year)
  // Matches: MM-DD-YY, MM-DD-YYYY, YYYY-MM-DD
  const dateMatch = filename.match(/(\d{1,2}[-_]\d{1,2}[-_]\d{2,4})|(\d{4}[-_]\d{1,2}[-_]\d{1,2})/);
  let meetingDate: string | undefined;
  
  if (dateMatch) {
    meetingDate = normalizeDateString(dateMatch[0]);
    // If we found a full date, update the year to match the date
    if (meetingDate) {
      year = meetingDate.split("-")[0];
    }
  }

  return {
    town,
    category,
    board,
    year,
    isMinutes: category === "minutes",
    meetingDate,
    filename,
  };
}

function detectBoardFromFilename(filename: string): string | undefined {
  const lower = filename.toLowerCase().replace(/[_-]/g, " ");
  
  const boards: Record<string, string[]> = {
    "Board of Selectmen": ["selectmen", "bos", "select board"],
    "Planning Board": ["planning"],
    "Zoning Board": ["zoning", "zba"],
    "School Board": ["school board", "school dist"],
    "Budget Committee": ["budget comm", "budget cmte"],
    "Conservation Commission": ["conservation"],
    "Library Trustees": ["library"],
    "Trustees of Trust Funds": ["trustee of trust", "trustees of trust"],
    "Fire Precinct": ["fire precinct", "fire comm"],
  };

  for (const [formalName, keywords] of Object.entries(boards)) {
    if (keywords.some(k => lower.includes(k))) {
      return formalName;
    }
  }
  return undefined;
}

function detectCategoryFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  
  if (lower.includes("minute") || lower.includes("min_")) return "minutes";
  if (lower.includes("agenda")) return "agendas";
  if (lower.includes("budget") || lower.includes("expenditure") || lower.includes("revenue")) return "financials";
  if (lower.includes("report") || lower.includes("audit")) return "reports";
  if (lower.includes("ordinance") || lower.includes("regulation") || lower.includes("policy")) return "ordinances";
  if (lower.includes("permit") || lower.includes("application")) return "permits";
  if (lower.includes("warrant")) return "warrants";
  if (lower.includes("tax")) return "tax_records";
  
  return "document"; // fallback
}

function normalizeDateString(dateStr: string): string {
  // Convert various date formats to YYYY-MM-DD
  const cleaned = dateStr.replace(/_/g, "-");
  const parts = cleaned.split("-");
  
  if (parts.length !== 3) return dateStr;
  
  // Check if it's YYYY-MM-DD or MM-DD-YY format
  if (parts[0].length === 4) {
    return cleaned; // Already YYYY-MM-DD
  }
  
  // Assume MM-DD-YY or MM-DD-YYYY
  let year = parts[2];
  if (year.length === 2) {
    year = parseInt(year) > 50 ? `19${year}` : `20${year}`;
  }
  
  return `${year}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
}

// ============================================================
// S3 OPERATIONS
// ============================================================

export interface S3File {
  key: string;
  size: number;
  lastModified: Date;
}

export async function listS3Files(prefix: string = ""): Promise<S3File[]> {
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
          // Only include PDF files
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

export async function downloadS3File(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  });
  
  const response = await s3.send(command);
  
  if (!response.Body) {
    throw new Error(`Empty response body for ${key}`);
  }
  
  // Convert stream to buffer
  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];
  
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ============================================================
// GEMINI UPLOAD
// ============================================================

export interface UploadResult {
  success: boolean;
  fileId?: string;
  storeId?: string;
  error?: string;
}

export async function uploadToGemini(
  fileBuffer: Buffer,
  metadata: ExtractedMetadata,
  storeId: string
): Promise<UploadResult> {
  // Write to temp file (Gemini SDK requires file path)
  const tempDir = path.join("/tmp", "s3sync");
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
    const fileId = opResponse.response?.documentName 
                || opResponse.documentName
                || opResponse.response?.files?.[0]?.name;
    
    if (!fileId) {
      throw new Error("Failed to extract document ID from response");
    }
    
    return { success: true, fileId, storeId };
    
  } finally {
    // Cleanup temp file
    await fs.unlink(tempPath).catch(() => {});
  }
}

// ============================================================
// SYNC ORCHESTRATION
// ============================================================

export interface SyncOptions {
  town?: string;           // Sync specific town only
  dryRun?: boolean;        // List files without uploading
  concurrency?: number;    // Parallel uploads (default: 3)
  limit?: number;          // Max files to process
}

export interface SyncResult {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  errors: Array<{ key: string; error: string }>;
}

export async function syncS3ToGemini(options: SyncOptions = {}): Promise<SyncResult> {
  const { town, dryRun = false, concurrency = 3, limit } = options;
  
  console.log(`[S3Sync] Starting sync...`);
  console.log(`[S3Sync] Options: town=${town || "all"}, dryRun=${dryRun}, concurrency=${concurrency}`);
  
  // List files from S3
  const prefix = town ? `${town}/` : "";
  const allFiles = await listS3Files(prefix);
  const files = limit ? allFiles.slice(0, limit) : allFiles;
  
  console.log(`[S3Sync] Found ${files.length} PDF files`);
  
  if (dryRun) {
    console.log(`[S3Sync] DRY RUN - would upload:`);
    for (const file of files) {
      const meta = extractMetadataFromPath(file.key);
      console.log(`  ${file.key} → ${meta.town}/${meta.category}/${meta.board || ""}/${meta.year || ""}`);
    }
    return { total: files.length, uploaded: 0, skipped: 0, failed: 0, errors: [] };
  }
  
  const result: SyncResult = {
    total: files.length,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  
  // Process in batches
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        try {
          const metadata = extractMetadataFromPath(file.key);
          const storeId = await getOrCreateTownStore(metadata.town);
          const fileBuffer = await downloadS3File(file.key);
          
          const uploadResult = await uploadToGemini(fileBuffer, metadata, storeId);
          
          if (uploadResult.success) {
            console.log(`[S3Sync] ✓ ${file.key}`);
            return { success: true };
          } else {
            throw new Error(uploadResult.error || "Unknown error");
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[S3Sync] ✗ ${file.key}: ${errorMsg}`);
          return { success: false, key: file.key, error: errorMsg };
        }
      })
    );
    
    for (const r of batchResults) {
      if (r.success) {
        result.uploaded++;
      } else {
        result.failed++;
        result.errors.push({ key: r.key!, error: r.error! });
      }
    }
    
    // Progress update
    const processed = i + batch.length;
    if (processed % 10 === 0 || processed === files.length) {
      console.log(`[S3Sync] Progress: ${processed}/${files.length} (${result.uploaded} uploaded, ${result.failed} failed)`);
    }
    
    // Small delay between batches to avoid rate limits
    if (i + concurrency < files.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  console.log(`[S3Sync] Complete: ${result.uploaded} uploaded, ${result.failed} failed`);
  return result;
}

// CLI entry point moved to scripts/sync-s3.ts
