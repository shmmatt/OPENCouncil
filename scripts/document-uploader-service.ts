#!/usr/bin/env tsx
/**
 * Document Uploader Service
 * 
 * A persistent background service that watches for document batches
 * and uploads them to S3. Runs independently of OpenClaw.
 * 
 * Usage:
 *   tsx scripts/document-uploader-service.ts
 * 
 * Or via systemd:
 *   sudo systemctl start opencouncil-uploader
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import * as path from 'path';
import { watch } from 'fs';

// ==================== Configuration ====================

const S3_BUCKET = 'opencouncil-municipal-docs';
const S3_REGION = 'us-east-1';
const UPLOAD_QUEUE_DIR = path.join(process.cwd(), 'upload-queue');
const TEMP_DIR = '/tmp/opencouncil-docs';
const LOG_FILE = path.join(process.cwd(), 'logs', 'uploader-service.log');

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'AKIAXEEDJLE2AYAKJDMZ',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

// ==================== Logging ====================

async function log(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  console.log(logMessage.trim());
  
  try {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
    await fs.appendFile(LOG_FILE, logMessage);
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
}

// ==================== S3 Upload ====================

async function documentExistsInS3(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }));
    return true;
  } catch {
    return false;
  }
}

async function uploadToS3(filePath: string, s3Key: string): Promise<boolean> {
  try {
    const fileContent = await fs.readFile(filePath);
    
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: fileContent,
      ContentType: filePath.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
    }));
    
    return true;
  } catch (error) {
    await log(`❌ S3 upload failed for ${s3Key}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}

// ==================== Upload Queue Processing ====================

interface UploadQueueItem {
  townName: string;
  documents: Array<{
    localPath: string;
    s3Key: string;
    url: string;
    title: string;
  }>;
}

async function processUploadQueue(queueFile: string): Promise<void> {
  const startTime = Date.now();
  await log(`📦 Processing upload queue: ${path.basename(queueFile)}`);
  
  try {
    const content = await fs.readFile(queueFile, 'utf-8');
    const queue: UploadQueueItem = JSON.parse(content);
    
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    
    for (const doc of queue.documents) {
      // Check if already exists in S3
      if (await documentExistsInS3(doc.s3Key)) {
        skipped++;
        continue;
      }
      
      // Upload to S3
      if (await uploadToS3(doc.localPath, doc.s3Key)) {
        uploaded++;
        
        // Delete local file after successful upload
        try {
          await fs.unlink(doc.localPath);
        } catch (error) {
          // Ignore deletion errors
        }
      } else {
        failed++;
      }
      
      // Progress log every 50 docs
      if ((uploaded + skipped + failed) % 50 === 0) {
        await log(`   Progress: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    await log(`✅ Completed ${queue.townName}: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed (${duration} min)`);
    
    // Move queue file to processed/
    const processedDir = path.join(UPLOAD_QUEUE_DIR, 'processed');
    await fs.mkdir(processedDir, { recursive: true });
    const processedPath = path.join(processedDir, path.basename(queueFile));
    await fs.rename(queueFile, processedPath);
    
  } catch (error) {
    await log(`❌ Failed to process queue ${queueFile}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function scanAndProcessQueue(): Promise<void> {
  try {
    await fs.mkdir(UPLOAD_QUEUE_DIR, { recursive: true });
    
    const files = await fs.readdir(UPLOAD_QUEUE_DIR);
    const queueFiles = files
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => path.join(UPLOAD_QUEUE_DIR, f));
    
    if (queueFiles.length === 0) {
      return;
    }
    
    await log(`📋 Found ${queueFiles.length} upload queue(s)`);
    
    for (const queueFile of queueFiles) {
      await processUploadQueue(queueFile);
    }
    
  } catch (error) {
    await log(`❌ Error scanning queue: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ==================== File Watcher ====================

async function watchUploadQueue(): Promise<void> {
  await log('👀 Watching upload queue directory...');
  
  await fs.mkdir(UPLOAD_QUEUE_DIR, { recursive: true });
  
  const watcher = watch(UPLOAD_QUEUE_DIR, { recursive: false }, async (eventType, filename) => {
    if (filename && filename.endsWith('.json') && !filename.startsWith('.')) {
      await log(`📬 New upload queue detected: ${filename}`);
      // Wait a moment to ensure file is fully written
      await new Promise(resolve => setTimeout(resolve, 1000));
      await scanAndProcessQueue();
    }
  });
  
  // Keep process alive
  process.on('SIGTERM', () => {
    log('🛑 Received SIGTERM, shutting down...');
    watcher.close();
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    log('🛑 Received SIGINT, shutting down...');
    watcher.close();
    process.exit(0);
  });
}

// ==================== Main ====================

async function main() {
  await log('🚀 Document Uploader Service starting...');
  await log(`   S3 Bucket: ${S3_BUCKET}`);
  await log(`   Upload Queue: ${UPLOAD_QUEUE_DIR}`);
  await log(`   Temp Dir: ${TEMP_DIR}`);
  
  // Process any existing queues
  await scanAndProcessQueue();
  
  // Start watching for new queues
  await watchUploadQueue();
  
  await log('✅ Service initialized and watching for uploads');
}

// Run service
main().catch(async (error) => {
  await log(`💀 Fatal error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exit(1);
});
