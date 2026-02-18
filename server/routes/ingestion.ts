import { Router } from "express";
import multer from "multer";
import crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { storage } from "../storage";
import { logInfo, logError, logWarn } from "../utils/logger";
import { authenticateAdmin } from "../middleware/auth";
import { uploadDocumentToFileStore } from "../gemini-client";
import { processFile, formatDuplicateWarning } from "../services/fileProcessing";
import { suggestMetadataFromPreview, validateMetadata, isValidNHTown } from "../services/metadataExtraction";
import { blobStorage } from "../services/blobStorage";
import { parallelUpload, type UploadJob } from "../services/parallelUpload";
import type { DocumentMetadata, IngestionJobStatus } from "@shared/schema";

const router = Router();

const persistentUpload = multer({
  dest: "uploads/blobs/",
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOCX, and TXT files are allowed.'));
    }
  },
});

router.post(
  "/analyze",
  authenticateAdmin,
  (req, res, next) => {
    persistentUpload.array("files", 100)(req, res, (err) => {
      if (err) {
        logError("upload_batch_failed", {
          stage: "multer_upload",
          errorCode: err.code,
          errorMessage: err.message,
        });
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ message: "Too many files. Maximum 100 files allowed per batch." });
        }
        return res.status(400).json({ message: err.message || "File upload error" });
      }
      next();
    });
  },
  async (req, res) => {
    const uploadedFiles = req.files as Express.Multer.File[];
    const batchId = crypto.randomUUID().slice(0, 8);
    
    logInfo("upload_batch_started", {
      batchId,
      fileCount: uploadedFiles?.length || 0,
      stage: "ingestion_analyze",
    });
    
    let metadataHints: { defaultTown?: string; defaultBoard?: string } | undefined;
    try {
      if (req.body.metadataHints) {
        const rawHints = JSON.parse(req.body.metadataHints);
        metadataHints = {};
        
        if (rawHints.defaultTown && typeof rawHints.defaultTown === "string") {
          const normalizedTown = rawHints.defaultTown.trim();
          if (normalizedTown && isValidNHTown(normalizedTown)) {
            metadataHints.defaultTown = normalizedTown;
          } else if (normalizedTown) {
            console.warn(`Invalid defaultTown hint: "${normalizedTown}" - not in NH_TOWNS list`);
          }
        }
        
        if (rawHints.defaultBoard && typeof rawHints.defaultBoard === "string") {
          metadataHints.defaultBoard = rawHints.defaultBoard.trim();
        }
        
        if (!metadataHints.defaultTown && !metadataHints.defaultBoard) {
          metadataHints = undefined;
        }
      }
    } catch (e) {
      console.warn("Could not parse metadataHints:", e);
    }
    
    try {
      if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({ message: "No files uploaded" });
      }

      const results = [];

      let successCount = 0;
      let failureCount = 0;
      
      for (let i = 0; i < uploadedFiles.length; i++) {
        const file = uploadedFiles[i];
        const fileIndex = i + 1;
        
        logInfo("upload_file_processing", {
          batchId,
          fileIndex,
          totalFiles: uploadedFiles.length,
          filename: file.originalname,
          fileSize: file.size,
          stage: "processing_start",
        });
        
        try {
          const fileResult = await processFile(file.path, file.originalname);
          
          let finalStoragePath = file.path;
          try {
            const fileBuffer = await fs.readFile(file.path);
            const storageResult = await blobStorage.saveFile(fileBuffer, file.originalname);
            finalStoragePath = storageResult.storagePath;
            await fs.unlink(file.path).catch(() => {});
          } catch (storageError) {
            logWarn("upload_object_storage_failed", {
              batchId,
              filename: file.originalname,
              errorMessage: storageError instanceof Error ? storageError.message : "Unknown error",
              stage: "object_storage_save",
            });
          }
          
          const duplicates = await storage.findDuplicateBlobs(
            fileResult.rawHash,
            fileResult.previewHash || undefined
          );

          let duplicateWarning: string | null = null;
          if (duplicates.exact) {
            duplicateWarning = formatDuplicateWarning({
              isExactDuplicate: true,
              isPreviewMatch: false,
              existingFilename: duplicates.exact.originalFilename,
              existingBlobId: duplicates.exact.id,
            });
          } else if (duplicates.preview) {
            duplicateWarning = formatDuplicateWarning({
              isExactDuplicate: false,
              isPreviewMatch: true,
              existingFilename: duplicates.preview.originalFilename,
              existingBlobId: duplicates.preview.id,
            });
          }

          const fileBlob = await storage.createFileBlob({
            rawHash: fileResult.rawHash,
            previewHash: fileResult.previewHash,
            sizeBytes: fileResult.sizeBytes,
            mimeType: fileResult.mimeType,
            originalFilename: file.originalname,
            storagePath: finalStoragePath,
            previewText: fileResult.previewText.slice(0, 15000),
            extractedTextCharCount: fileResult.extractedTextCharCount,
            needsOcr: fileResult.needsOcr,
            ocrStatus: fileResult.ocrStatus,
            ocrQueuedAt: fileResult.needsOcr && fileResult.ocrStatus === 'queued' ? new Date() : null,
          });

          const suggestedMetadata = await suggestMetadataFromPreview(
            file.originalname,
            fileResult.previewText,
            metadataHints
          );
          
          let statusNote: string | null = null;
          if (!suggestedMetadata.town || suggestedMetadata.town.trim() === "") {
            statusNote = "No town detected - manual review required";
          }

          const ingestionJob = await storage.createIngestionJob({
            fileBlobId: fileBlob.id,
            status: "needs_review",
            suggestedMetadata: suggestedMetadata,
            metadataHints: metadataHints || null,
            duplicateWarning,
            statusNote,
          });
          
          successCount++;
          logInfo("upload_file_success", {
            batchId,
            fileIndex,
            filename: file.originalname,
            jobId: ingestionJob.id,
            fileBlobId: fileBlob.id,
            needsOcr: fileResult.needsOcr,
            hasDuplicateWarning: !!duplicateWarning,
            stage: "ingestion_job_created",
          });

          results.push({
            jobId: ingestionJob.id,
            filename: file.originalname,
            suggestedMetadata,
            duplicateWarning,
            previewExcerpt: fileResult.previewText.slice(0, 500),
          });
        } catch (fileError) {
          failureCount++;
          const errorMessage = fileError instanceof Error ? fileError.message : "Processing failed";
          logError("upload_file_failed", {
            batchId,
            fileIndex,
            filename: file.originalname,
            errorMessage,
            errorStack: fileError instanceof Error ? fileError.stack : undefined,
            stage: "file_processing",
          });
          
          try {
            await fs.unlink(file.path);
          } catch (e) {
            logWarn("upload_cleanup_failed", {
              batchId,
              filename: file.originalname,
              stage: "cleanup",
            });
          }
          results.push({
            jobId: null,
            filename: file.originalname,
            error: errorMessage,
            suggestedMetadata: {
              category: "misc_other",
              town: "",
              board: "",
              year: "",
              notes: "",
            },
            duplicateWarning: null,
          });
        }
      }
      
      logInfo("upload_batch_completed", {
        batchId,
        totalFiles: uploadedFiles.length,
        successCount,
        failureCount,
        stage: "batch_complete",
      });

      res.json({ jobs: results });
    } catch (error) {
      logError("upload_batch_error", {
        batchId,
        fileCount: uploadedFiles?.length || 0,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
        errorStack: error instanceof Error ? error.stack : undefined,
        stage: "batch_fatal_error",
      });
      
      for (const file of uploadedFiles) {
        try {
          await fs.unlink(file.path);
        } catch (e) {
          logWarn("upload_cleanup_failed", {
            batchId,
            filename: file.originalname,
            stage: "error_cleanup",
          });
        }
      }
      
      res.status(500).json({ message: "Failed to analyze files" });
    }
  }
);

router.get("/jobs", authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    
    let jobs;
    if (status && typeof status === "string") {
      jobs = await storage.getIngestionJobsByStatus(status as IngestionJobStatus);
    } else {
      jobs = await storage.getAllIngestionJobs();
    }
    
    res.json(jobs);
  } catch (error) {
    console.error("Error fetching ingestion jobs:", error);
    res.status(500).json({ message: "Failed to fetch ingestion jobs" });
  }
});

router.get("/jobs/:jobId", authenticateAdmin, async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await storage.getIngestionJobWithBlob(jobId);
    
    if (!job) {
      return res.status(404).json({ message: "Ingestion job not found" });
    }
    
    res.json(job);
  } catch (error) {
    console.error("Error fetching ingestion job:", error);
    res.status(500).json({ message: "Failed to fetch ingestion job" });
  }
});

router.post("/jobs/:jobId/approve", authenticateAdmin, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { finalMetadata, documentLinkMode, documentId } = req.body;

    const job = await storage.getIngestionJobWithBlob(jobId);
    if (!job) {
      return res.status(404).json({ message: "Ingestion job not found" });
    }

    if (job.status !== "needs_review") {
      return res.status(400).json({ message: `Job is already ${job.status}` });
    }

    const validatedMetadata = validateMetadata(finalMetadata);
    
    if (finalMetadata.isMinutes !== undefined) {
      (validatedMetadata as any).isMinutes = Boolean(finalMetadata.isMinutes);
    }
    if (finalMetadata.meetingDate) {
      (validatedMetadata as any).meetingDate = finalMetadata.meetingDate;
    }
    if (finalMetadata.meetingType) {
      (validatedMetadata as any).meetingType = finalMetadata.meetingType;
    }
    if (finalMetadata.rawDateText) {
      (validatedMetadata as any).rawDateText = finalMetadata.rawDateText;
    }
    
    if ((validatedMetadata as any).isMinutes) {
      validatedMetadata.category = "meeting_minutes";
    }

    let logicalDocId: string;
    
    if (documentLinkMode === "existing" && documentId) {
      const existingDoc = await storage.getLogicalDocumentById(documentId);
      if (!existingDoc) {
        return res.status(400).json({ message: "Specified document not found" });
      }
      logicalDocId = existingDoc.id;
      
      await storage.updateLogicalDocument(logicalDocId, {
        category: validatedMetadata.category,
        town: validatedMetadata.town || existingDoc.town,
        board: validatedMetadata.board || existingDoc.board,
      });
    } else {
      const newDoc = await storage.createLogicalDocument({
        canonicalTitle: job.fileBlob.originalFilename,
        town: validatedMetadata.town || "statewide",
        board: validatedMetadata.board || null,
        category: validatedMetadata.category,
      });
      logicalDocId = newDoc.id;
    }

    await storage.updateIngestionJob(jobId, {
      status: "approved",
      finalMetadata: validatedMetadata,
      documentId: logicalDocId,
    });

    res.json({ 
      success: true, 
      jobId, 
      documentId: logicalDocId,
      status: "approved" 
    });
  } catch (error) {
    console.error("Error approving ingestion job:", error);
    res.status(500).json({ message: "Failed to approve ingestion job" });
  }
});

router.post("/jobs/:jobId/index", authenticateAdmin, async (req, res) => {
  const { jobId } = req.params;
  
  try {
    const job = await storage.getIngestionJobWithBlob(jobId);
    if (!job) {
      return res.status(404).json({ message: "Ingestion job not found" });
    }

    if (job.status !== "approved" && job.status !== "index_failed") {
      return res.status(400).json({ message: `Job must be approved or index_failed to retry indexing. Current status: ${job.status}` });
    }

    if (!job.documentId) {
      return res.status(400).json({ message: "Job must have a linked document" });
    }

    const finalMetadata = job.finalMetadata as DocumentMetadata;
    if (!finalMetadata) {
      return res.status(400).json({ message: "Job must have final metadata" });
    }

    const { fileId, storeId } = await uploadDocumentToFileStore(
      job.fileBlob.storagePath,
      job.fileBlob.originalFilename,
      finalMetadata
    );

    const previousVersion = await storage.getCurrentVersionForDocument(job.documentId);

    let meetingDateObj: Date | null = null;
    if (finalMetadata.meetingDate) {
      const parsed = new Date(finalMetadata.meetingDate);
      if (!isNaN(parsed.getTime())) {
        meetingDateObj = parsed;
      }
    }

    const version = await storage.createDocumentVersion({
      documentId: job.documentId,
      fileBlobId: job.fileBlobId,
      year: finalMetadata.year || null,
      notes: finalMetadata.notes || null,
      fileSearchStoreName: storeId,
      fileSearchDocumentName: fileId,
      isCurrent: true,
      supersedesVersionId: previousVersion?.id || null,
      meetingDate: meetingDateObj,
      isMinutes: finalMetadata.isMinutes || false,
    });

    await storage.setCurrentVersion(job.documentId, version.id);

    await storage.updateIngestionJob(jobId, {
      status: "indexed",
      documentVersionId: version.id,
      statusNote: null,
    });

    await storage.createDocument({
      filename: job.fileBlob.storagePath.split('/').pop() || job.fileBlob.originalFilename,
      originalName: job.fileBlob.originalFilename,
      fileSearchFileId: fileId,
      fileSearchStoreId: storeId,
      category: finalMetadata.category,
      town: finalMetadata.town || null,
      board: finalMetadata.board || null,
      year: finalMetadata.year ? parseInt(finalMetadata.year) : null,
      notes: finalMetadata.notes || null,
    });

    res.json({
      success: true,
      jobId,
      documentId: job.documentId,
      versionId: version.id,
      fileSearchDocumentName: fileId,
      status: "indexed",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to index ingestion job";
    console.error("Error indexing ingestion job:", error);
    
    try {
      await storage.updateIngestionJob(jobId, {
        status: "index_failed",
        statusNote: `Indexing failed: ${errorMessage}`,
      });
    } catch (updateError) {
      console.error("Failed to update job status to index_failed:", updateError);
    }
    
    res.status(500).json({ 
      message: errorMessage,
      status: "index_failed",
      retryable: true,
    });
  }
});

router.post("/jobs/batch-index", authenticateAdmin, async (req, res) => {
  try {
    const { jobIds, concurrency = 3 } = req.body;
    
    if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
      return res.status(400).json({ message: "jobIds array is required" });
    }
    
    if (jobIds.length > 50) {
      return res.status(400).json({ message: "Maximum 50 jobs per batch" });
    }
    
    const jobs = await Promise.all(
      jobIds.map(id => storage.getIngestionJobWithBlob(id))
    );
    
    const validJobs: Array<{ job: typeof jobs[0], index: number }> = [];
    const errors: Array<{ jobId: string; error: string }> = [];
    
    jobs.forEach((job, index) => {
      const jobId = jobIds[index];
      
      if (!job) {
        errors.push({ jobId, error: "Job not found" });
        return;
      }
      
      if (job.status !== "approved" && job.status !== "index_failed") {
        errors.push({ jobId, error: `Job must be approved or index_failed. Current: ${job.status}` });
        return;
      }
      
      if (!job.documentId) {
        errors.push({ jobId, error: "Job must have a linked document" });
        return;
      }
      
      if (!job.finalMetadata) {
        errors.push({ jobId, error: "Job must have final metadata" });
        return;
      }
      
      validJobs.push({ job, index });
    });
    
    if (validJobs.length === 0) {
      return res.status(400).json({ 
        message: "No valid jobs to index",
        errors,
      });
    }
    
    const uploadJobs: UploadJob[] = validJobs.map(({ job }) => ({
      id: job!.id,
      filePath: job!.fileBlob.storagePath,
      filename: job!.fileBlob.originalFilename,
      metadata: job!.finalMetadata as DocumentMetadata,
    }));
    
    const uploadResults = await parallelUpload(uploadJobs, Math.min(concurrency, 5));
    
    const indexed: Array<{ jobId: string; documentId: string; versionId: string }> = [];
    const failed: Array<{ jobId: string; error: string }> = [...errors];
    
    for (let i = 0; i < uploadResults.length; i++) {
      const result = uploadResults[i];
      const { job } = validJobs[i];
      
      if (!result.success) {
        failed.push({ jobId: result.id, error: result.error || "Upload failed" });
        
        try {
          await storage.updateIngestionJob(result.id, {
            status: "index_failed",
            statusNote: `Batch indexing failed: ${result.error}`,
          });
        } catch (e) {
          console.error("Failed to update job status:", e);
        }
        continue;
      }
      
      try {
        const finalMetadata = job!.finalMetadata as DocumentMetadata;
        const previousVersion = await storage.getCurrentVersionForDocument(job!.documentId!);
        
        let meetingDateObj: Date | null = null;
        if (finalMetadata.meetingDate) {
          const parsed = new Date(finalMetadata.meetingDate);
          if (!isNaN(parsed.getTime())) {
            meetingDateObj = parsed;
          }
        }
        
        const version = await storage.createDocumentVersion({
          documentId: job!.documentId!,
          fileBlobId: job!.fileBlobId,
          year: finalMetadata.year || null,
          notes: finalMetadata.notes || null,
          fileSearchStoreName: result.storeId!,
          fileSearchDocumentName: result.fileId!,
          isCurrent: true,
          supersedesVersionId: previousVersion?.id || null,
          meetingDate: meetingDateObj,
          isMinutes: finalMetadata.isMinutes || false,
        });
        
        await storage.setCurrentVersion(job!.documentId!, version.id);
        
        await storage.updateIngestionJob(job!.id, {
          status: "indexed",
          documentVersionId: version.id,
          statusNote: null,
        });
        
        await storage.createDocument({
          filename: job!.fileBlob.storagePath.split('/').pop() || job!.fileBlob.originalFilename,
          originalName: job!.fileBlob.originalFilename,
          fileSearchFileId: result.fileId!,
          fileSearchStoreId: result.storeId!,
          category: finalMetadata.category,
          town: finalMetadata.town || null,
          board: finalMetadata.board || null,
          year: finalMetadata.year ? parseInt(finalMetadata.year) : null,
          notes: finalMetadata.notes || null,
        });
        
        indexed.push({
          jobId: job!.id,
          documentId: job!.documentId!,
          versionId: version.id,
        });
      } catch (dbError) {
        const errorMessage = dbError instanceof Error ? dbError.message : "Database error";
        failed.push({ jobId: job!.id, error: errorMessage });
        
        try {
          await storage.updateIngestionJob(job!.id, {
            status: "index_failed",
            statusNote: `Database update failed: ${errorMessage}`,
          });
        } catch (e) {
          console.error("Failed to update job status:", e);
        }
      }
    }
    
    res.json({
      success: true,
      total: jobIds.length,
      indexed: indexed.length,
      failed: failed.length,
      results: { indexed, failed },
    });
  } catch (error) {
    console.error("Error in batch index:", error);
    res.status(500).json({ 
      message: error instanceof Error ? error.message : "Batch index failed" 
    });
  }
});

router.post("/jobs/:jobId/reject", authenticateAdmin, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { reason } = req.body;

    const job = await storage.getIngestionJobById(jobId);
    if (!job) {
      return res.status(404).json({ message: "Ingestion job not found" });
    }

    if (job.status === "indexed") {
      return res.status(400).json({ message: "Cannot reject an already indexed job" });
    }

    await storage.updateIngestionJob(jobId, {
      status: "rejected",
      finalMetadata: { rejectionReason: reason || "Rejected by admin" },
    });

    res.json({ success: true, jobId, status: "rejected" });
  } catch (error) {
    console.error("Error rejecting ingestion job:", error);
    res.status(500).json({ message: "Failed to reject ingestion job" });
  }
});

export default router;
