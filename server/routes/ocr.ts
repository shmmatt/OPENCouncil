import { Router } from "express";
import { storage } from "../storage";
import { authenticateAdmin } from "../middleware/auth";
import { reindexOcrDocument } from "../gemini-client";
import { getOcrConfig } from "../config/ocr";
import * as ocrJobsStore from "../storage/ocrJobs";
import type { DocumentMetadata } from "@shared/schema";

const router = Router();

router.get("/queue", authenticateAdmin, async (req, res) => {
  try {
    const blobs = await storage.getFileBlobsNeedingOcr();
    res.json(blobs);
  } catch (error) {
    console.error("Error fetching OCR queue:", error);
    res.status(500).json({ message: "Failed to fetch OCR queue" });
  }
});

router.post("/queue/:blobId", authenticateAdmin, async (req, res) => {
  try {
    const { blobId } = req.params;
    
    const blob = await storage.getFileBlobById(blobId);
    if (!blob) {
      return res.status(404).json({ message: "File blob not found" });
    }
    
    if (blob.ocrStatus === 'queued' || blob.ocrStatus === 'processing') {
      return res.status(400).json({ message: `OCR already ${blob.ocrStatus}` });
    }
    
    await storage.queueFileBlobForOcr(blobId);
    
    const updated = await storage.getFileBlobById(blobId);
    res.json(updated);
  } catch (error) {
    console.error("Error queueing OCR:", error);
    res.status(500).json({ message: "Failed to queue OCR" });
  }
});

router.get("/status/:blobId", authenticateAdmin, async (req, res) => {
  try {
    const { blobId } = req.params;
    
    const blob = await storage.getFileBlobById(blobId);
    if (!blob) {
      return res.status(404).json({ message: "File blob not found" });
    }
    
    res.json({
      id: blob.id,
      originalFilename: blob.originalFilename,
      needsOcr: blob.needsOcr,
      ocrStatus: blob.ocrStatus,
      extractedTextCharCount: blob.extractedTextCharCount,
      ocrTextCharCount: blob.ocrTextCharCount,
      ocrFailureReason: blob.ocrFailureReason,
      ocrQueuedAt: blob.ocrQueuedAt,
      ocrStartedAt: blob.ocrStartedAt,
      ocrCompletedAt: blob.ocrCompletedAt,
    });
  } catch (error) {
    console.error("Error fetching OCR status:", error);
    res.status(500).json({ message: "Failed to fetch OCR status" });
  }
});

router.post("/reprocess-legacy", authenticateAdmin, async (req, res) => {
  try {
    const config = getOcrConfig();
    
    const blobsNeedingOcr = await storage.getFileBlobsNeedingOcrQueue(config.minCharThreshold);
    
    let queued = 0;
    
    for (const blob of blobsNeedingOcr) {
      await storage.queueFileBlobForOcr(blob.id);
      queued++;
    }
    
    res.json({
      success: true,
      message: `Queued ${queued} documents for OCR processing.`,
      stats: { queued, threshold: config.minCharThreshold }
    });
  } catch (error) {
    console.error("Error reprocessing legacy documents:", error);
    res.status(500).json({ message: "Failed to reprocess legacy documents" });
  }
});

router.get("/stats", authenticateAdmin, async (req, res) => {
  try {
    const stats = await storage.getOcrQueueStats();
    res.json(stats);
  } catch (error) {
    console.error("Error fetching OCR stats:", error);
    res.status(500).json({ message: "Failed to fetch OCR stats" });
  }
});

router.post("/reset-stuck", authenticateAdmin, async (req, res) => {
  try {
    const resetCount = await storage.resetStuckProcessingJobs();
    res.json({
      success: true,
      message: `Reset ${resetCount} stuck processing jobs back to queued.`,
      resetCount
    });
  } catch (error) {
    console.error("Error resetting stuck OCR jobs:", error);
    res.status(500).json({ message: "Failed to reset stuck jobs" });
  }
});

router.post("/retry-failed-missing", authenticateAdmin, async (req, res) => {
  try {
    const count = await storage.retryOcrFailedMissingFiles();
    res.json({
      success: true,
      message: count > 0 
        ? `Reset ${count} failed OCR jobs to queued status. They will be processed by the OCR worker.`
        : "No failed OCR jobs with missing file errors found.",
      queued: count,
    });
  } catch (error) {
    console.error("Error retrying failed OCR jobs:", error);
    res.status(500).json({ message: "Failed to retry failed OCR jobs" });
  }
});

router.get("/failed-missing-count", authenticateAdmin, async (req, res) => {
  try {
    const count = await storage.getOcrFailedMissingFileCount();
    res.json({ count });
  } catch (error) {
    console.error("Error getting failed missing count:", error);
    res.status(500).json({ message: "Failed to get count" });
  }
});

router.post("/reindex-completed", authenticateAdmin, async (req, res) => {
  try {
    const BATCH_SIZE = 20;
    const allDocsToReindex = await storage.getOcrCompletedNeedingReindex();
    
    if (allDocsToReindex.length === 0) {
      return res.json({
        success: true,
        message: "No OCR-completed documents need re-indexing.",
        reindexed: 0,
        failed: 0,
        remaining: 0,
      });
    }

    const docsToProcess = allDocsToReindex.slice(0, BATCH_SIZE);
    const remaining = allDocsToReindex.length - docsToProcess.length;

    let reindexed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const doc of docsToProcess) {
      try {
        if (!doc.fileBlob.ocrText) {
          errors.push(`${doc.fileBlob.originalFilename}: No OCR text available`);
          failed++;
          continue;
        }

        const metadata: DocumentMetadata = {
          category: doc.metadata.category || 'other',
          town: doc.metadata.town,
          board: doc.metadata.board,
          year: doc.metadata.year,
          notes: doc.metadata.notes,
          isMinutes: doc.metadata.isMinutes,
          meetingDate: doc.metadata.meetingDate,
          meetingType: doc.metadata.meetingType,
          rawDateText: doc.metadata.rawDateText || null,
        };

        await reindexOcrDocument(doc.fileBlob.ocrText, doc.fileBlob.originalFilename, metadata);
        await storage.markOcrReindexed(doc.fileBlob.id);
        reindexed++;
        console.log(`[Batch Reindex] Successfully re-indexed: ${doc.fileBlob.originalFilename}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`${doc.fileBlob.originalFilename}: ${errorMessage}`);
        failed++;
        console.error(`[Batch Reindex] Failed: ${doc.fileBlob.originalFilename}:`, errorMessage);
      }
    }

    res.json({
      success: true,
      message: remaining > 0 
        ? `Re-indexed ${reindexed} documents. ${failed} failed. ${remaining} remaining.`
        : `Re-indexed ${reindexed} documents. ${failed} failed.`,
      reindexed,
      failed,
      remaining,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error batch re-indexing OCR documents:", error);
    res.status(500).json({ message: "Failed to batch re-index OCR documents" });
  }
});

router.get("/textract/stats", authenticateAdmin, async (req, res) => {
  try {
    const stats = await ocrJobsStore.getOcrJobStats();
    res.json(stats);
  } catch (error) {
    console.error("Error fetching Textract OCR stats:", error);
    res.status(500).json({ message: "Failed to fetch Textract OCR stats" });
  }
});

router.post("/textract/enqueue", authenticateAdmin, async (req, res) => {
  try {
    const { documents } = req.body;
    if (!Array.isArray(documents) || documents.length === 0) {
      return res.status(400).json({ message: "Provide an array of documents with documentId, s3Bucket, s3Key" });
    }
    const enqueued = await ocrJobsStore.enqueueDocumentsForOcr(documents);
    res.json({ success: true, enqueued });
  } catch (error) {
    console.error("Error enqueuing Textract jobs:", error);
    res.status(500).json({ message: "Failed to enqueue Textract jobs" });
  }
});

router.get("/textract/jobs", authenticateAdmin, async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    if (status) {
      const jobs = await ocrJobsStore.getOcrJobsByStatus(status);
      res.json(jobs);
    } else {
      const stats = await ocrJobsStore.getOcrJobStats();
      res.json(stats);
    }
  } catch (error) {
    console.error("Error fetching Textract jobs:", error);
    res.status(500).json({ message: "Failed to fetch Textract jobs" });
  }
});

router.get("/textract/job/:id", authenticateAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid job ID" });
    }
    const job = await ocrJobsStore.getOcrJobById(id);
    if (!job) {
      return res.status(404).json({ message: "OCR job not found" });
    }
    res.json(job);
  } catch (error) {
    console.error("Error fetching Textract job:", error);
    res.status(500).json({ message: "Failed to fetch Textract job" });
  }
});

router.post("/textract/reset-stuck", authenticateAdmin, async (req, res) => {
  try {
    const resetCount = await ocrJobsStore.resetStuckOcrJobs();
    res.json({
      success: true,
      message: `Reset ${resetCount} stuck Textract jobs.`,
      resetCount,
    });
  } catch (error) {
    console.error("Error resetting stuck Textract jobs:", error);
    res.status(500).json({ message: "Failed to reset stuck Textract jobs" });
  }
});

export default router;
