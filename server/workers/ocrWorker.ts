import Tesseract from 'tesseract.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { storage } from '../storage';
import { getOcrConfig } from '../config/ocr';
import type { FileBlob } from '@shared/schema';

let pdfPoppler: any = null;

async function getPdfPoppler(): Promise<any> {
  if (!pdfPoppler) {
    try {
      pdfPoppler = await import('pdf-poppler');
    } catch (e) {
      console.warn('[OCR Worker] pdf-poppler not available, using fallback');
      return null;
    }
  }
  return pdfPoppler;
}

async function convertPdfToImages(pdfPath: string, outputDir: string): Promise<string[]> {
  const poppler = await getPdfPoppler();
  
  if (!poppler) {
    throw new Error('PDF to image conversion not available (pdf-poppler not installed)');
  }
  
  const opts = {
    format: 'png',
    out_dir: outputDir,
    out_prefix: 'page',
    page: null,
  };
  
  await poppler.convert(pdfPath, opts);
  
  const files = await fs.readdir(outputDir);
  const imageFiles = files
    .filter(f => f.startsWith('page') && f.endsWith('.png'))
    .sort()
    .map(f => path.join(outputDir, f));
  
  return imageFiles;
}

async function performOcrOnImage(imagePath: string): Promise<string> {
  const result = await Tesseract.recognize(imagePath, 'eng', {
    logger: () => {},
  });
  return result.data.text;
}

async function performOcrOnPdf(pdfPath: string): Promise<string> {
  const tmpDir = path.join('/tmp', `ocr-${Date.now()}`);
  
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    
    const imageFiles = await convertPdfToImages(pdfPath, tmpDir);
    
    if (imageFiles.length === 0) {
      throw new Error('No pages found in PDF');
    }
    
    console.log(`[OCR Worker] Processing ${imageFiles.length} pages`);
    
    const texts: string[] = [];
    for (let i = 0; i < imageFiles.length; i++) {
      console.log(`[OCR Worker] Processing page ${i + 1}/${imageFiles.length}`);
      const pageText = await performOcrOnImage(imageFiles[i]);
      texts.push(pageText);
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
  
  try {
    if (!fileBlob.storagePath) {
      throw new Error('No storage path for file');
    }
    
    const filePath = fileBlob.storagePath;
    
    await fs.access(filePath);
    
    let ocrText: string;
    
    if (fileBlob.mimeType.includes('pdf')) {
      ocrText = await performOcrOnPdf(filePath);
    } else {
      ocrText = await performOcrOnImage(filePath);
    }
    
    const ocrTextCharCount = ocrText.length;
    
    await storage.updateOcrStatus(fileBlob.id, 'completed', {
      ocrText,
      ocrTextCharCount,
    });
    
    console.log(`[OCR Worker] Completed ${fileBlob.originalFilename}: ${ocrTextCharCount} chars extracted`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[OCR Worker] Failed ${fileBlob.originalFilename}:`, errorMessage);
    
    await storage.updateOcrStatus(fileBlob.id, 'failed', {
      ocrFailureReason: errorMessage,
    });
  }
}

let workerRunning = false;
let pollInterval: NodeJS.Timeout | null = null;

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
  
  const poll = async () => {
    if (!workerRunning) return;
    
    try {
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
