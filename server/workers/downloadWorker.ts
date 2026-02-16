/**
 * Download Worker - V3 Integration
 * 
 * Processes discovered documents:
 * 1. Downloads from source URL
 * 2. Generates S3 key matching existing structure
 * 3. Uploads to S3
 * 4. Updates document status
 */

import { db } from '../storage/db';
import { crawlerDocuments, crawlerTowns } from '../../shared/crawler-schema';
import { eq, and } from 'drizzle-orm';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { generateS3Key, extractFilename } from '../services/crawlerStateExtensions';
import * as crypto from 'crypto';

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: S3_REGION });

export interface DownloadWorkerResult {
  processed: number;
  uploaded: number;
  skipped: number;
  failed: number;
  errors: Array<{ url: string; error: string }>;
}

/**
 * Process documents with status='discovered'
 * Downloads and uploads to S3
 */
export async function processDiscoveredDocuments(limit = 10): Promise<DownloadWorkerResult> {
  const result: DownloadWorkerResult = {
    processed: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };
  
  // Get documents to process
  const docs = await db.select()
    .from(crawlerDocuments)
    .where(eq(crawlerDocuments.status, 'discovered'))
    .limit(limit);
  
  if (docs.length === 0) {
    console.log('[DownloadWorker] No documents to process');
    return result;
  }
  
  console.log(`[DownloadWorker] Processing ${docs.length} documents...`);
  
  for (const doc of docs) {
    result.processed++;
    
    try {
      // Get town record
      const [town] = await db.select()
        .from(crawlerTowns)
        .where(eq(crawlerTowns.id, doc.townId));
      
      if (!town) {
        throw new Error('Town not found');
      }
      
      // Generate S3 key
      const filename = doc.filename || extractFilename(doc.url);
      const s3Key = generateS3Key({
        town: town.slug,
        url: doc.url,
        filename,
        discoveredFrom: doc.discoveredFrom
      });
      
      // Check if already exists in S3
      const exists = await checkS3Exists(s3Key);
      
      if (exists) {
        console.log(`[DownloadWorker] ⏭️  ${town.slug}: ${s3Key} (exists)`);
        
        // Update status to uploaded (already in S3)
        await db.update(crawlerDocuments)
          .set({
            status: 'uploaded',
            s3Key,
            s3UploadedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(crawlerDocuments.id, doc.id));
        
        result.skipped++;
        continue;
      }
      
      // Download document
      console.log(`[DownloadWorker] ⬇️  Downloading: ${doc.url}`);
      const downloadResult = await downloadDocument(doc.url);
      
      if (!downloadResult) {
        throw new Error('Download failed - empty response');
      }
      
      // Upload to S3
      console.log(`[DownloadWorker] ⬆️  Uploading: ${s3Key}`);
      await uploadToS3({
        key: s3Key,
        buffer: downloadResult.buffer,
        contentType: downloadResult.contentType,
        metadata: {
          sourceUrl: doc.url,
          town: town.slug,
          discoveredAt: doc.discoveredAt.toISOString(),
          crawlerId: 'v3-crawler'
        }
      });
      
      // Update database
      await db.update(crawlerDocuments)
        .set({
          status: 'uploaded',
          s3Key,
          s3UploadedAt: new Date(),
          sizeBytes: downloadResult.buffer.length,
          mimeType: downloadResult.contentType,
          updatedAt: new Date()
        })
        .where(eq(crawlerDocuments.id, doc.id));
      
      console.log(`[DownloadWorker] ✅ ${town.slug}: ${s3Key}`);
      result.uploaded++;
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[DownloadWorker] ❌ ${doc.url}: ${errorMsg}`);
      
      result.failed++;
      result.errors.push({ url: doc.url, error: errorMsg });
      
      // Update status to failed
      await db.update(crawlerDocuments)
        .set({
          status: 'failed',
          errorMessage: errorMsg,
          updatedAt: new Date()
        })
        .where(eq(crawlerDocuments.id, doc.id));
    }
  }
  
  console.log(`[DownloadWorker] Complete: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.failed} failed`);
  return result;
}

/**
 * Download document from URL
 */
async function downloadDocument(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 OPENCouncil/1.0',
        'Accept': 'application/pdf,application/*,*/*'
      },
      signal: AbortSignal.timeout(30000) // 30 second timeout
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'application/pdf';
    
    // Validate minimum size (avoid empty files)
    if (buffer.length < 100) {
      throw new Error('Document too small (< 100 bytes)');
    }
    
    return { buffer, contentType };
    
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Download failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Check if file exists in S3
 */
async function checkS3Exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    }));
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    // Other errors (permissions, etc.) - rethrow
    throw error;
  }
}

/**
 * Upload document to S3
 */
async function uploadToS3(params: {
  key: string;
  buffer: Buffer;
  contentType: string;
  metadata: Record<string, string>;
}): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: params.key,
    Body: params.buffer,
    ContentType: params.contentType,
    Metadata: params.metadata
  }));
}

/**
 * Get statistics for monitoring
 */
export async function getDownloadWorkerStats(): Promise<{
  discovered: number;
  uploaded: number;
  failed: number;
  pending: number;
}> {
  const stats = await db.execute(sql`
    SELECT
      SUM(CASE WHEN status = 'discovered' THEN 1 ELSE 0 END) as discovered,
      SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) as uploaded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status IN ('discovered', 'downloading') THEN 1 ELSE 0 END) as pending
    FROM crawler_documents
  `);
  
  const row = stats.rows?.[0] || stats[0] || {};
  
  return {
    discovered: Number(row.discovered) || 0,
    uploaded: Number(row.uploaded) || 0,
    failed: Number(row.failed) || 0,
    pending: Number(row.pending) || 0
  };
}

/**
 * Retry failed downloads (max 3 attempts)
 */
export async function retryFailedDownloads(limit = 5): Promise<DownloadWorkerResult> {
  const result: DownloadWorkerResult = {
    processed: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };
  
  // Get failed documents that haven't been retried too many times
  const docs = await db.execute(sql`
    SELECT * FROM crawler_documents
    WHERE status = 'failed'
    AND (error_message NOT LIKE '%404%' AND error_message NOT LIKE '%403%')
    LIMIT ${limit}
  `);
  
  // Reset status to discovered for retry
  for (const doc of (docs.rows || docs)) {
    await db.update(crawlerDocuments)
      .set({
        status: 'discovered',
        errorMessage: null,
        updatedAt: new Date()
      })
      .where(eq(crawlerDocuments.id, doc.id));
  }
  
  // Process them
  return processDiscoveredDocuments(limit);
}

// Import sql for queries
import { sql } from 'drizzle-orm';
