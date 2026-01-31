
import { db, schema, eq } from "../storage/db";
import { s3GeminiSync } from "@shared/schema";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import { extractMetadataFromPath } from "./s3Sync"; // Reuse our improved metadata logic

// Config
const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const S3_REGION = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region: S3_REGION });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

/**
 * Step 1: Discovery
 * Scans S3 and inserts new files into the DB as 'pending'
 */
export async function discoverS3Files(town?: string) {
  console.log(`[Ingest] Starting discovery for town: ${town || 'ALL'}`);
  
  let continuationToken: string | undefined;
  let count = 0;
  let newFiles = 0;

  do {
    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: town ? `${town}/` : "",
      ContinuationToken: continuationToken,
    });

    const response = await s3.send(command);
    
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (!obj.Key || !obj.Key.toLowerCase().endsWith(".pdf")) continue;

        const s3Key = obj.Key;
        
        // 1. Check if exists in DB
        const existing = await db.query.s3GeminiSync.findFirst({
          where: eq(schema.s3GeminiSync.s3Key, s3Key)
        });

        if (existing) {
          // TODO: Check ETag/LastModified to handle updates?
          continue; 
        }

        // 2. Extract Metadata
        let meta;
        try {
          meta = extractMetadataFromPath(s3Key);
        } catch (e) {
          console.warn(`[Ingest] Failed metadata for ${s3Key}:`, e);
          meta = { town: 'unknown', category: 'uncategorized', filename: s3Key };
        }

        // 3. Insert into DB
        try {
          // Resolve store ID (simple map for now, can be db query later)
          // For now, we put a placeholder storeId, the upload worker will fix/create it
          const storeIdPlaceholder = `pending_resolution:${meta.town}`; 

          await db.insert(schema.s3GeminiSync).values({
            s3Key,
            geminiStoreId: storeIdPlaceholder, 
            town: meta.town,
            category: meta.category,
            board: meta.board,
            year: meta.year,
            sizeBytes: obj.Size || 0,
            status: "pending"
          });
          newFiles++;
        } catch (err) {
          console.error(`[Ingest] DB Insert failed for ${s3Key}`, err);
        }
        
        count++;
      }
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  console.log(`[Ingest] Discovery complete. Scanned ${count} files. Added ${newFiles} new files.`);
  return { scanned: count, added: newFiles };
}
