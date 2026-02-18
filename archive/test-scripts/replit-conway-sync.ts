/**
 * Conway S3 → Gemini File Search Sync
 * 
 * Run this in your Replit console:
 *   npx tsx replit-conway-sync.ts
 * 
 * Requires: AWS credentials in Replit secrets (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import * as fs from "fs/promises";
import * as path from "path";
import { Readable } from "stream";

// Config
const S3_BUCKET = "opencouncil-municipal-docs";
const S3_REGION = "us-east-1";
const TOWN = "conway";
const CONCURRENCY = 3;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const s3 = new S3Client({ region: S3_REGION });

let conwayStoreId: string | null = null;

// Get or create Conway store
async function getConwayStore(): Promise<string> {
  if (conwayStoreId) return conwayStoreId;
  
  // Try to find existing store first
  const stores = await ai.fileSearchStores.list();
  for await (const store of stores) {
    if (store.displayName?.includes("Conway")) {
      conwayStoreId = store.name!;
      console.log(`Found existing Conway store: ${conwayStoreId}`);
      return conwayStoreId;
    }
  }
  
  // Create new store
  const store = await ai.fileSearchStores.create({
    config: { displayName: "OPENCouncil - Conway" },
  });
  conwayStoreId = store.name!;
  console.log(`Created Conway store: ${conwayStoreId}`);
  return conwayStoreId;
}

// List files from S3
async function listS3Files(): Promise<Array<{ key: string; size: number }>> {
  const files: Array<{ key: string; size: number }> = [];
  let token: string | undefined;
  
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `${TOWN}/`,
      ContinuationToken: token,
    });
    const resp = await s3.send(cmd);
    
    for (const obj of resp.Contents || []) {
      if (obj.Key?.toLowerCase().endsWith(".pdf") && obj.Size) {
        files.push({ key: obj.Key, size: obj.Size });
      }
    }
    token = resp.NextContinuationToken;
  } while (token);
  
  return files;
}

// Download file from S3
async function downloadFile(key: string): Promise<Buffer> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const stream = resp.Body as Readable;
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Extract metadata from S3 path
function extractMetadata(key: string) {
  const parts = key.split("/").filter(Boolean);
  const filename = parts[parts.length - 1];
  const category = parts[1] || "misc";
  const isMinutes = category === "minutes";
  
  let board: string | undefined;
  let year: string | undefined;
  
  if (isMinutes && parts.length >= 4) {
    board = parts[2].replace(/_/g, " ");
    if (/^\d{4}/.test(parts[3])) {
      year = parts[3].substring(0, 4);
    }
  }
  
  return { filename, category, isMinutes, board, year };
}

// Upload to Gemini
async function uploadToGemini(buffer: Buffer, key: string, storeId: string): Promise<boolean> {
  const meta = extractMetadata(key);
  const tempDir = "/tmp/conway-sync";
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${Date.now()}_${meta.filename}`);
  
  try {
    await fs.writeFile(tempPath, buffer);
    
    const displayParts: string[] = ["Conway"];
    if (meta.board) displayParts.push(meta.board);
    if (meta.year) displayParts.push(meta.year);
    const displayName = `[${displayParts.join(" - ")}] ${meta.filename}`;
    
    const customMetadata: Array<{ key: string; stringValue: string }> = [
      { key: "town", stringValue: "conway" },
      { key: "category", stringValue: meta.isMinutes ? "meeting_minutes" : meta.category },
      { key: "source", stringValue: "s3_sync" },
    ];
    if (meta.board) customMetadata.push({ key: "board", stringValue: meta.board });
    if (meta.year) customMetadata.push({ key: "year", stringValue: meta.year });
    
    await ai.fileSearchStores.uploadToFileSearchStore({
      file: tempPath,
      fileSearchStoreName: storeId,
      config: {
        displayName,
        mimeType: "application/pdf",
        customMetadata,
        chunkingConfig: { whiteSpaceConfig: { maxTokensPerChunk: 200, maxOverlapTokens: 20 } },
      },
    });
    
    return true;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

// Main sync
async function main() {
  console.log("=== Conway S3 → Gemini Sync ===\n");
  
  const storeId = await getConwayStore();
  const files = await listS3Files();
  console.log(`Found ${files.length} PDF files in S3\n`);
  
  let uploaded = 0, failed = 0;
  
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    
    await Promise.all(batch.map(async (f) => {
      try {
        const buffer = await downloadFile(f.key);
        await uploadToGemini(buffer, f.key, storeId);
        console.log(`✓ ${f.key}`);
        uploaded++;
      } catch (err) {
        console.error(`✗ ${f.key}: ${err}`);
        failed++;
      }
    }));
    
    if ((i + CONCURRENCY) % 30 === 0) {
      console.log(`\nProgress: ${i + batch.length}/${files.length} (${uploaded} ok, ${failed} failed)\n`);
    }
    
    // Rate limit pause
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`\n=== Complete ===`);
  console.log(`Uploaded: ${uploaded}`);
  console.log(`Failed: ${failed}`);
}

main().catch(console.error);
