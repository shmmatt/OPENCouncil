import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { storage } from '../storage';
import { getOcrConfig } from '../config/ocr';
import { reindexOcrDocument } from '../gemini-client';
import { blobStorage } from '../services/blobStorage';
import type { FileBlob, DocumentMetadata } from '@shared/schema';

const execAsync = promisify(exec);

let pdftoppmAvailable: boolean | null = null;
let nativeTesseractAvailable: boolean | null = null;

async function checkPdftoppm(): Promise<boolean> {
  if (pdftoppmAvailable !== null) return pdftoppmAvailable;
  
  try {
    await execAsync('which pdftoppm');
    pdftoppmAvailable = true;
    console.log('[OCR Worker] pdftoppm is available');
  } catch {
    pdftoppmAvailable = false;
    console.warn('[OCR Worker] pdftoppm not available - PDF OCR will be limited');
  }
  return pdftoppmAvailable;
}

async function checkNativeTesseract(): Promise<boolean> {
  if (nativeTesseractAvailable !== null) return nativeTesseractAvailable;
  
  try {
    await execAsync('which tesseract');
    nativeTesseractAvailable = true;
    console.log('[OCR Worker] Native tesseract binary is available (faster mode)');
  } catch {
    nativeTesseractAvailable = false;
    console.warn('[OCR Worker] Native tesseract not available, will use tesseract.js (slower)');
  }
  return nativeTesseractAvailable;
}

async function convertPdfToImages(pdfPath: string, outputDir: string): Promise<string[]> {
  const available = await checkPdftoppm();
  
  if (!available) {
    throw new Error('pdftoppm not available. Install poppler_utils system package.');
  }
  
  const outPrefix = path.join(outputDir, 'page');
  
  await execAsync(`pdftoppm -png "${pdfPath}" "${outPrefix}"`);
  
  const files = await fs.readdir(outputDir);
  const imageFiles = files
    .filter(f => f.startsWith('page') && f.endsWith('.png'))
    .sort()
    .map(f => path.join(outputDir, f));
  
  return imageFiles;
}

async function performOcrOnImageNative(imagePath: string): Promise<string> {
  const outputBase = imagePath.replace(/\.[^/.]+$/, '_ocr');
  const outputFile = `${outputBase}.txt`;
  
  try {
    await execAsync(`tesseract "${imagePath}" "${outputBase}" -l eng --psm 3`);
    const text = await fs.readFile(outputFile, 'utf-8');
    await fs.unlink(outputFile).catch(() => {});
    return text;
  } catch (error: any) {
    await fs.unlink(outputFile).catch(() => {});
    throw new Error(`Native tesseract failed: ${error.message}`);
  }
}

async function performOcrOnImageFallback(imagePath: string): Promise<string> {
  const Tesseract = await import('tesseract.js');
  const result = await Tesseract.default.recognize(imagePath, 'eng', {
    logger: () => {},
  });
  return result.data.text;
}

async function performOcrOnImage(imagePath: string): Promise<string> {
  const useNative = await checkNativeTesseract();
  
  if (useNative) {
    return performOcrOnImageNative(imagePath);
  }
  
  return performOcrOnImageFallback(imagePath);
}

const OCR_CONCURRENCY = 4;

async function processPageBatch(imageFiles: string[], startIdx: number, batchSize: number): Promise<{ index: number; text: string }[]> {
  const batch = imageFiles.slice(startIdx, startIdx + batchSize);
  const results = await Promise.all(
    batch.map(async (imagePath, i) => {
      const pageNum = startIdx + i + 1;
      console.log(`[OCR Worker] Processing page ${pageNum}/${imageFiles.length}`);
      const text = await performOcrOnImage(imagePath);
      return { index: startIdx + i, text };
    })
  );
  return results;
}

async function performOcrOnPdf(pdfPath: string): Promise<string> {
  const available = await checkPdftoppm();
  
  if (!available) {
    throw new Error('PDF to image conversion not available. Install poppler_utils system package.');
  }
  
  const tmpDir = path.join('/tmp', `ocr-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    
    const imageFiles = await convertPdfToImages(pdfPath, tmpDir);
    
    if (imageFiles.length === 0) {
      throw new Error('No pages found in PDF');
    }
    
    console.log(`[OCR Worker] Processing ${imageFiles.length} pages (${OCR_CONCURRENCY} concurrent)`);
    
    const texts: string[] = new Array(imageFiles.length);
    
    for (let i = 0; i < imageFiles.length; i += OCR_CONCURRENCY) {
      const results = await processPageBatch(imageFiles, i, OCR_CONCURRENCY);
      for (const { index, text } of results) {
        texts[index] = text;
      }
    }
    
    return texts.join('\n\n--- Page Break ---\n\n');
  } finally {
    try {
      const files = await fs.readdir(tmpDir);
      for (const file of files) {
        await fs.unlink(path.join(tmpDir, file));
      }
      await fs.rmdir(tmpDir);
    } catch (e) {
    }
  }
}

async function processOcrJob(fileBlob: FileBlob): Promise<void> {
  console.log(`[OCR Worker] Processing ${fileBlob.originalFilename} (${fileBlob.id})`);
  
  let tempFilePath: string | null = null;
  
  try {
    if (!fileBlob.storagePath) {
      throw new Error('No storage path for file');
    }
    
    const isPdf = fileBlob.mimeType.includes('pdf');
    const isImage = fileBlob.mimeType.startsWith('image/');
    
    if (!isPdf && !isImage) {
      console.log(`[OCR Worker] Skipping non-OCR-able file type: ${fileBlob.mimeType}`);
      await storage.updateOcrStatus(fileBlob.id, 'failed', {
        ocrFailureReason: `File type ${fileBlob.mimeType} cannot be processed with OCR`,
      });
      return;
    }
    
    // Read file from storage (handles both object storage and local files)
    const fileBuffer = await blobStorage.readFile(fileBlob.storagePath);
    
    // Create a temp file for OCR processing (pdftoppm needs a file path)
    const tempDir = path.join('uploads', 'ocr-temp');
    await fs.mkdir(tempDir, { recursive: true });
    const ext = path.extname(fileBlob.originalFilename) || '.pdf';
    tempFilePath = path.join(tempDir, `${fileBlob.id}${ext}`);
    await fs.writeFile(tempFilePath, fileBuffer);
    
    let ocrText: string;
    
    if (isPdf) {
      ocrText = await performOcrOnPdf(tempFilePath);
    } else {
      ocrText = await performOcrOnImage(tempFilePath);
    }
    
    const ocrTextCharCount = ocrText.length;
    
    await storage.updateOcrStatus(fileBlob.id, 'completed', {
      ocrText,
      ocrTextCharCount,
    });
    
    console.log(`[OCR Worker] Completed ${fileBlob.originalFilename}: ${ocrTextCharCount} chars extracted`);
    
    await reindexAfterOcr(fileBlob.id, ocrText, fileBlob.originalFilename);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[OCR Worker] Failed ${fileBlob.originalFilename}:`, errorMessage);
    
    await storage.updateOcrStatus(fileBlob.id, 'failed', {
      ocrFailureReason: errorMessage,
    });
  } finally {
    // Clean up temp file
    if (tempFilePath) {
      await fs.unlink(tempFilePath).catch(() => {});
    }
  }
}

async function reindexAfterOcr(fileBlobId: string, ocrText: string, filename: string): Promise<void> {
  try {
    const ingestionData = await storage.getIngestionMetadataForFileBlob(fileBlobId);
    
    if (!ingestionData) {
      console.log(`[OCR Worker] No ingestion job found for ${filename}, will be picked up by batch reindex`);
      return;
    }
    
    if (!ingestionData.isIndexed) {
      console.log(`[OCR Worker] Ingestion job not yet indexed for ${filename}, will be picked up by batch reindex`);
      return;
    }
    
    const docMetadata = ingestionData.metadata;
    const metadata: DocumentMetadata = {
      category: docMetadata.category || 'other',
      town: docMetadata.town,
      board: docMetadata.board,
      year: docMetadata.year,
      notes: docMetadata.notes,
      isMinutes: docMetadata.isMinutes,
      meetingDate: docMetadata.meetingDate,
      meetingType: docMetadata.meetingType,
      rawDateText: docMetadata.rawDateText || null,
    };
    
    console.log(`[OCR Worker] Reindexing ${filename} into RAG with ${ocrText.length} chars`);
    
    await reindexOcrDocument(ocrText, filename, metadata);
    await storage.markOcrReindexed(fileBlobId);
    
    console.log(`[OCR Worker] Successfully reindexed ${filename}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[OCR Worker] Reindex failed for ${filename}:`, errorMessage);
  }
}

let workerRunning = false;
let pollInterval: NodeJS.Timeout | null = null;
let lastRecoveryCheck = 0;
const RECOVERY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check for stale jobs every 5 minutes
const STALE_JOB_THRESHOLD_MINUTES = 30; // Jobs processing for more than 30 min are considered stale

export async function startOcrWorker(pollIntervalMs: number = 10000): Promise<void> {
  const config = getOcrConfig();
  
  if (!config.enabled) {
    console.log('[OCR Worker] OCR is disabled, worker not starting');
    return;
  }
  
  if (config.provider === 'none') {
    console.log('[OCR Worker] No OCR provider configured, worker not starting');
    return;
  }
  
  if (workerRunning) {
    console.log('[OCR Worker] Worker already running');
    return;
  }
  
  workerRunning = true;
  console.log(`[OCR Worker] Starting with ${config.provider} provider, polling every ${pollIntervalMs}ms`);
  
  // Recover any stale jobs on startup
  try {
    const recovered = await storage.recoverStaleOcrJobs(STALE_JOB_THRESHOLD_MINUTES);
    if (recovered > 0) {
      console.log(`[OCR Worker] Recovered ${recovered} stale processing jobs on startup`);
    }
  } catch (error) {
    console.error('[OCR Worker] Error recovering stale jobs on startup:', error);
  }
  
  const poll = async () => {
    if (!workerRunning) return;
    
    try {
      // Periodically check for and recover stale jobs
      const now = Date.now();
      if (now - lastRecoveryCheck > RECOVERY_CHECK_INTERVAL_MS) {
        lastRecoveryCheck = now;
        const recovered = await storage.recoverStaleOcrJobs(STALE_JOB_THRESHOLD_MINUTES);
        if (recovered > 0) {
          console.log(`[OCR Worker] Recovered ${recovered} stale processing jobs`);
        }
      }
      
      const job = await storage.claimNextOcrJob();
      
      if (job) {
        await processOcrJob(job);
        if (workerRunning) {
          setImmediate(poll);
          return;
        }
      }
    } catch (error) {
      console.error('[OCR Worker] Error in poll cycle:', error);
    }
    
    if (workerRunning) {
      pollInterval = setTimeout(poll, pollIntervalMs);
    }
  };
  
  poll();
}

export function stopOcrWorker(): void {
  workerRunning = false;
  if (pollInterval) {
    clearTimeout(pollInterval);
    pollInterval = null;
  }
  console.log('[OCR Worker] Stopped');
}

export { processOcrJob };
