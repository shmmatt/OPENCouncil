/**
 * Parallel upload utilities for Gemini File Search
 * 
 * Provides concurrent upload capability to speed up document ingestion.
 */

import { uploadDocumentToFileStore, type DocumentMetadata } from "../gemini-client";
import { logInfo, logError } from "../utils/logger";

export interface UploadJob {
  id: string;
  filePath: string;
  filename: string;
  metadata: DocumentMetadata;
}

export interface UploadResult {
  id: string;
  success: boolean;
  fileId?: string;
  storeId?: string;
  error?: string;
}

/**
 * Default concurrency limit for Gemini uploads.
 * Gemini has rate limits, so we don't want to go too high.
 * 3-5 seems to be a safe sweet spot.
 */
const DEFAULT_CONCURRENCY = 3;

/**
 * Upload multiple documents to Gemini File Search in parallel.
 * 
 * @param jobs - Array of upload jobs
 * @param concurrency - Max concurrent uploads (default: 3)
 * @returns Array of results in same order as jobs
 */
export async function parallelUpload(
  jobs: UploadJob[],
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<UploadResult[]> {
  if (jobs.length === 0) return [];
  
  logInfo("parallel_upload_start", {
    jobCount: jobs.length,
    concurrency,
  });
  
  const startTime = Date.now();
  const results: UploadResult[] = new Array(jobs.length);
  let completedCount = 0;
  let successCount = 0;
  let failureCount = 0;
  
  // Process in batches of `concurrency` size
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const batchPromises = batch.map(async (job, batchIndex) => {
      const jobIndex = i + batchIndex;
      try {
        const { fileId, storeId } = await uploadDocumentToFileStore(
          job.filePath,
          job.filename,
          job.metadata
        );
        
        results[jobIndex] = {
          id: job.id,
          success: true,
          fileId,
          storeId,
        };
        successCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        logError("parallel_upload_job_failed", {
          jobId: job.id,
          filename: job.filename,
          error: errorMessage,
        });
        
        results[jobIndex] = {
          id: job.id,
          success: false,
          error: errorMessage,
        };
        failureCount++;
      }
      
      completedCount++;
      
      // Log progress every few uploads
      if (completedCount % 5 === 0 || completedCount === jobs.length) {
        logInfo("parallel_upload_progress", {
          completed: completedCount,
          total: jobs.length,
          success: successCount,
          failed: failureCount,
        });
      }
    });
    
    await Promise.all(batchPromises);
  }
  
  const durationMs = Date.now() - startTime;
  const avgTimePerFile = Math.round(durationMs / jobs.length);
  
  logInfo("parallel_upload_complete", {
    total: jobs.length,
    success: successCount,
    failed: failureCount,
    durationMs,
    avgTimePerFileMs: avgTimePerFile,
  });
  
  return results;
}

/**
 * Helper to chunk an array into batches
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
