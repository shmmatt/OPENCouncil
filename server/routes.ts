import type { Express } from "express";
import { createServer, type Server } from "http";
import express from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import { storage } from "./storage";
import { authenticateAdmin, generateToken } from "./middleware/auth";
import { requireRole } from "./auth/middleware";
import type { IdentityRequest } from "./auth/types";
import { uploadDocumentToFileStore, askQuestionWithFileSearch } from "./gemini-client";
import { extractPreviewText, suggestMetadataFromContent } from "./bulk-upload-helper";
import { processFile, formatDuplicateWarning } from "./services/fileProcessing";
import { suggestMetadataFromPreview, validateMetadata, isValidNHTown } from "./services/metadataExtraction";
import { insertDocumentSchema, insertChatMessageSchema, ALLOWED_CATEGORIES, documentMetadataSchema } from "@shared/schema";
import type { DocumentMetadata, IngestionJobStatus, ActorIdentifier } from "@shared/schema";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { registerChatV2Routes } from "./chatV2/chatV2Route";
import { registerAdminUsageRoutes } from "./routes/adminUsageRoutes";
import { registerAdminChatAnalyticsRoutes } from "./routes/adminChatAnalyticsRoutes";

// Configure multer for file uploads
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
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

// Configure multer for persistent file storage (v2 pipeline)
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

export async function registerRoutes(app: Express): Promise<Server> {
  // Ensure upload directories exist
  await fs.mkdir("uploads/blobs", { recursive: true }).catch(() => {});

  // Admin login with bcrypt authentication
  app.post("/api/admin/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      const admin = await storage.getAdminByEmail(email);

      if (!admin) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      const passwordMatch = await bcrypt.compare(password, admin.passwordHash);

      if (!passwordMatch) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      const token = generateToken(email);
      return res.json({ token, email });
    } catch (error) {
      console.error("Login error:", error);
      return res.status(500).json({ message: "Login failed" });
    }
  });

  // ============================================================
  // LEGACY DOCUMENT ROUTES (backwards compatibility)
  // ============================================================

  // Get all documents (protected) - combines legacy and v2 documents
  app.get("/api/admin/documents", authenticateAdmin, async (req, res) => {
    try {
      const documents = await storage.getDocuments();
      res.json(documents);
    } catch (error) {
      console.error("Error fetching documents:", error);
      res.status(500).json({ message: "Failed to fetch documents" });
    }
  });

  // Upload document (protected) - legacy route, still works directly
  app.post(
    "/api/admin/documents/upload",
    authenticateAdmin,
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ message: "No file uploaded" });
        }

        const metadataRaw = req.body.metadata;
        if (!metadataRaw) {
          return res.status(400).json({ message: "Document metadata is required" });
        }

        let parsedMetadata: DocumentMetadata;
        try {
          const metadataJson = JSON.parse(metadataRaw);
          parsedMetadata = documentMetadataSchema.parse(metadataJson);
        } catch (parseError) {
          console.error("Metadata validation error:", parseError);
          return res.status(400).json({ 
            message: parseError instanceof z.ZodError 
              ? `Invalid metadata: ${parseError.errors.map(e => e.message).join(", ")}`
              : "Invalid metadata format" 
          });
        }

        const { fileId, storeId } = await uploadDocumentToFileStore(
          req.file.path,
          req.file.originalname,
          parsedMetadata
        );

        const document = await storage.createDocument({
          filename: req.file.filename,
          originalName: req.file.originalname,
          fileSearchFileId: fileId,
          fileSearchStoreId: storeId,
          category: parsedMetadata.category,
          town: parsedMetadata.town || null,
          board: parsedMetadata.board || null,
          year: parsedMetadata.year ? parseInt(parsedMetadata.year) : null,
          notes: parsedMetadata.notes || null,
        });

        await fs.unlink(req.file.path);

        res.json(document);
      } catch (error) {
        console.error("Error uploading document:", error);
        if (req.file) {
          try {
            await fs.unlink(req.file.path);
          } catch (unlinkError) {
            console.error("Error deleting file:", unlinkError);
          }
        }
        res.status(500).json({ message: error instanceof Error ? error.message : "Upload failed" });
      }
    }
  );

  // Delete document (protected)
  app.delete("/api/admin/documents/:id", authenticateAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      
      const document = await storage.getDocumentById(id);
      if (document) {
        try {
          await fs.unlink(path.join("uploads", document.filename));
        } catch (fileError) {
          console.log("File already deleted or doesn't exist");
        }
      }

      await storage.deleteDocument(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting document:", error);
      res.status(500).json({ message: "Failed to delete document" });
    }
  });

  // Legacy bulk upload routes (backwards compatibility)
  app.post(
    "/api/admin/bulk-upload/analyze",
    authenticateAdmin,
    (req, res, next) => {
      upload.array("files", 100)(req, res, (err) => {
        if (err) {
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
      
      try {
        if (!uploadedFiles || uploadedFiles.length === 0) {
          return res.status(400).json({ message: "No files uploaded" });
        }

        const results = [];

        for (const file of uploadedFiles) {
          try {
            const previewText = await extractPreviewText(file.path, file.originalname);
            const suggestedMetadata = await suggestMetadataFromContent(file.originalname, previewText);
            
            const tempUpload = await storage.createTempUpload({
              filename: file.filename,
              originalName: file.originalname,
              filePath: file.path,
              previewText: previewText.slice(0, 5000),
              suggestedCategory: suggestedMetadata.category,
              suggestedTown: suggestedMetadata.town,
              suggestedBoard: suggestedMetadata.board,
              suggestedYear: suggestedMetadata.year,
              suggestedNotes: suggestedMetadata.notes,
            });

            results.push({
              tempId: tempUpload.id,
              filename: file.originalname,
              suggestedMetadata,
            });
          } catch (fileError) {
            console.error(`Error processing file ${file.originalname}:`, fileError);
            try {
              await fs.unlink(file.path);
            } catch (e) {
              console.error("Error cleaning up failed file:", e);
            }
            results.push({
              tempId: null,
              filename: file.originalname,
              error: fileError instanceof Error ? fileError.message : "Processing failed",
              suggestedMetadata: {
                category: "misc_other",
                town: "",
                board: "",
                year: "",
                notes: "",
              },
            });
          }
        }

        res.json({ files: results });
      } catch (error) {
        console.error("Error in bulk upload analyze:", error);
        
        for (const file of uploadedFiles) {
          try {
            await fs.unlink(file.path);
          } catch (e) {
            console.error("Error cleaning up file:", e);
          }
        }
        
        res.status(500).json({ message: "Failed to analyze files" });
      }
    }
  );

  app.post("/api/admin/bulk-upload/finalize", authenticateAdmin, async (req, res) => {
    try {
      const { files } = req.body;
      
      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ message: "No files to upload" });
      }

      const uploaded: Array<{ filename: string; id: string }> = [];
      const failed: Array<{ filename: string; error: string }> = [];

      for (const fileData of files) {
        const { tempId, metadata } = fileData;
        let tempUpload = null;
        
        try {
          if (!tempId) {
            failed.push({ filename: fileData.filename || "Unknown", error: "No temp ID provided" });
            continue;
          }

          tempUpload = await storage.getTempUploadById(tempId);
          if (!tempUpload) {
            failed.push({ filename: fileData.filename || "Unknown", error: "Temporary file not found or expired" });
            continue;
          }

          let parsedMetadata;
          try {
            parsedMetadata = documentMetadataSchema.parse(metadata);
          } catch (validationError) {
            const errorMsg = validationError instanceof z.ZodError 
              ? validationError.errors.map(e => e.message).join(", ")
              : "Invalid metadata";
            failed.push({ filename: tempUpload.originalName, error: errorMsg });
            await cleanupTempUpload(tempId, tempUpload.filePath);
            continue;
          }

          const { fileId, storeId } = await uploadDocumentToFileStore(
            tempUpload.filePath,
            tempUpload.originalName,
            parsedMetadata
          );

          const yearValue = parsedMetadata.year && /^\d{4}$/.test(parsedMetadata.year) 
            ? parseInt(parsedMetadata.year, 10) 
            : null;

          const document = await storage.createDocument({
            filename: tempUpload.filename,
            originalName: tempUpload.originalName,
            fileSearchFileId: fileId,
            fileSearchStoreId: storeId,
            category: parsedMetadata.category,
            town: parsedMetadata.town || null,
            board: parsedMetadata.board || null,
            year: yearValue,
            notes: parsedMetadata.notes || null,
          });

          await cleanupTempUpload(tempId, tempUpload.filePath);

          uploaded.push({ filename: tempUpload.originalName, id: document.id });
        } catch (fileError) {
          console.error(`Error finalizing file ${tempId}:`, fileError);
          
          if (tempUpload) {
            await cleanupTempUpload(tempId, tempUpload.filePath);
          }
          
          failed.push({ 
            filename: tempUpload?.originalName || fileData.filename || "Unknown", 
            error: fileError instanceof Error ? fileError.message : "Upload failed" 
          });
        }
      }

      res.json({
        success: true,
        uploaded,
        failed,
      });
    } catch (error) {
      console.error("Error in bulk upload finalize:", error);
      res.status(500).json({ message: "Failed to finalize uploads" });
    }
  });

  async function cleanupTempUpload(tempId: string, filePath: string) {
    try {
      await fs.unlink(filePath);
    } catch (e) {
      console.log("Could not delete temp file:", e);
    }
    try {
      await storage.deleteTempUpload(tempId);
    } catch (e) {
      console.log("Could not delete temp upload record:", e);
    }
  }

  // ============================================================
  // V2 INGESTION PIPELINE ROUTES
  // ============================================================

  // Analyze files and create ingestion jobs (v2 pipeline)
  app.post(
    "/api/admin/ingestion/analyze",
    authenticateAdmin,
    (req, res, next) => {
      persistentUpload.array("files", 100)(req, res, (err) => {
        if (err) {
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
      
      // Parse and validate metadata hints from form data if provided
      let metadataHints: { defaultTown?: string; defaultBoard?: string } | undefined;
      try {
        if (req.body.metadataHints) {
          const rawHints = JSON.parse(req.body.metadataHints);
          metadataHints = {};
          
          // Validate defaultTown against NH_TOWNS list
          if (rawHints.defaultTown && typeof rawHints.defaultTown === "string") {
            const normalizedTown = rawHints.defaultTown.trim();
            if (normalizedTown && isValidNHTown(normalizedTown)) {
              metadataHints.defaultTown = normalizedTown;
            } else if (normalizedTown) {
              console.warn(`Invalid defaultTown hint: "${normalizedTown}" - not in NH_TOWNS list`);
            }
          }
          
          // Board can be any string (no validation needed)
          if (rawHints.defaultBoard && typeof rawHints.defaultBoard === "string") {
            metadataHints.defaultBoard = rawHints.defaultBoard.trim();
          }
          
          // Clear empty hints object
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

        for (const file of uploadedFiles) {
          try {
            // Process file: compute hashes and extract preview
            const fileResult = await processFile(file.path, file.originalname);
            
            // Check for duplicates
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

            // Create FileBlob record
            const fileBlob = await storage.createFileBlob({
              rawHash: fileResult.rawHash,
              previewHash: fileResult.previewHash,
              sizeBytes: fileResult.sizeBytes,
              mimeType: fileResult.mimeType,
              originalFilename: file.originalname,
              storagePath: file.path,
              previewText: fileResult.previewText.slice(0, 15000),
            });

            // Get LLM metadata suggestions with hints
            const suggestedMetadata = await suggestMetadataFromPreview(
              file.originalname,
              fileResult.previewText,
              metadataHints
            );
            
            // Determine status note if town is missing
            let statusNote: string | null = null;
            if (!suggestedMetadata.town || suggestedMetadata.town.trim() === "") {
              statusNote = "No town detected - manual review required";
            }

            // Create IngestionJob with hints
            const ingestionJob = await storage.createIngestionJob({
              fileBlobId: fileBlob.id,
              status: "needs_review",
              suggestedMetadata: suggestedMetadata,
              metadataHints: metadataHints || null,
              duplicateWarning,
              statusNote,
            });

            results.push({
              jobId: ingestionJob.id,
              filename: file.originalname,
              suggestedMetadata,
              duplicateWarning,
              previewExcerpt: fileResult.previewText.slice(0, 500),
            });
          } catch (fileError) {
            console.error(`Error processing file ${file.originalname}:`, fileError);
            try {
              await fs.unlink(file.path);
            } catch (e) {
              console.error("Error cleaning up failed file:", e);
            }
            results.push({
              jobId: null,
              filename: file.originalname,
              error: fileError instanceof Error ? fileError.message : "Processing failed",
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

        res.json({ jobs: results });
      } catch (error) {
        console.error("Error in ingestion analyze:", error);
        
        for (const file of uploadedFiles) {
          try {
            await fs.unlink(file.path);
          } catch (e) {
            console.error("Error cleaning up file:", e);
          }
        }
        
        res.status(500).json({ message: "Failed to analyze files" });
      }
    }
  );

  // Get all ingestion jobs (with optional status filter)
  app.get("/api/admin/ingestion/jobs", authenticateAdmin, async (req, res) => {
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

  // Get single ingestion job with blob details
  app.get("/api/admin/ingestion/jobs/:jobId", authenticateAdmin, async (req, res) => {
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

  // Approve ingestion job
  app.post("/api/admin/ingestion/jobs/:jobId/approve", authenticateAdmin, async (req, res) => {
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

      // Validate metadata - include minutes-specific fields
      const validatedMetadata = validateMetadata(finalMetadata);
      
      // Preserve minutes-specific fields that aren't handled by validateMetadata
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
      
      // If isMinutes is true, force category to meeting_minutes
      if ((validatedMetadata as any).isMinutes) {
        validatedMetadata.category = "meeting_minutes";
      }

      // Create or link to LogicalDocument
      let logicalDocId: string;
      
      if (documentLinkMode === "existing" && documentId) {
        const existingDoc = await storage.getLogicalDocumentById(documentId);
        if (!existingDoc) {
          return res.status(400).json({ message: "Specified document not found" });
        }
        logicalDocId = existingDoc.id;
        
        // Update existing document with admin's metadata overrides
        await storage.updateLogicalDocument(logicalDocId, {
          category: validatedMetadata.category,
          town: validatedMetadata.town || existingDoc.town,
          board: validatedMetadata.board || existingDoc.board,
        });
      } else {
        // Create new LogicalDocument
        const newDoc = await storage.createLogicalDocument({
          canonicalTitle: job.fileBlob.originalFilename,
          town: validatedMetadata.town || "statewide",
          board: validatedMetadata.board || null,
          category: validatedMetadata.category,
        });
        logicalDocId = newDoc.id;
      }

      // Update ingestion job
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

  // Index approved job to File Search
  app.post("/api/admin/ingestion/jobs/:jobId/index", authenticateAdmin, async (req, res) => {
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

      // Upload to Gemini File Search (with retry logic built-in)
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
      
      // Mark job as index_failed instead of just returning error
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

  // Reject ingestion job
  app.post("/api/admin/ingestion/jobs/:jobId/reject", authenticateAdmin, async (req, res) => {
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

  // ============================================================
  // V2 LOGICAL DOCUMENT ROUTES
  // ============================================================

  // Get all logical documents
  app.get("/api/admin/v2/documents", authenticateAdmin, async (req, res) => {
    try {
      const documents = await storage.getLogicalDocuments();
      res.json(documents);
    } catch (error) {
      console.error("Error fetching logical documents:", error);
      res.status(500).json({ message: "Failed to fetch documents" });
    }
  });

  // Get single logical document with versions
  app.get("/api/admin/v2/documents/:id", authenticateAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const document = await storage.getLogicalDocumentWithVersions(id);
      
      if (!document) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      res.json(document);
    } catch (error) {
      console.error("Error fetching document:", error);
      res.status(500).json({ message: "Failed to fetch document" });
    }
  });

  // Search logical documents
  app.get("/api/admin/v2/documents/search", authenticateAdmin, async (req, res) => {
    try {
      const { town, category, board } = req.query;
      const documents = await storage.searchLogicalDocuments({
        town: town as string | undefined,
        category: category as string | undefined,
        board: board as string | undefined,
      });
      res.json(documents);
    } catch (error) {
      console.error("Error searching documents:", error);
      res.status(500).json({ message: "Failed to search documents" });
    }
  });

  // ============================================================
  // CHAT ROUTES
  // ============================================================

  app.get("/api/chat/sessions", async (req, res) => {
    try {
      const actor = req.actor;
      const sessions = await storage.getChatSessions(actor ? {
        type: actor.actorType === 'user' ? 'user' : 'anon',
        userId: actor.userId,
        anonId: actor.anonId,
      } : undefined);
      res.json(sessions);
    } catch (error) {
      console.error("Error fetching sessions:", error);
      res.status(500).json({ message: "Failed to fetch sessions" });
    }
  });

  app.post("/api/chat/sessions", async (req, res) => {
    try {
      const { title } = req.body;
      const actor = req.actor;
      
      if (!actor || (!actor.userId && !actor.anonId)) {
        return res.status(401).json({ message: "Authentication required to create chat sessions" });
      }
      
      const session = await storage.createChatSession({
        title: title || "New conversation",
        userId: actor.actorType === 'user' ? actor.userId : undefined,
        anonId: actor.anonId,
      });
      res.json(session);
    } catch (error) {
      console.error("Error creating session:", error);
      res.status(500).json({ message: "Failed to create session" });
    }
  });

  app.get("/api/chat/sessions/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const messages = await storage.getMessagesBySessionId(id);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  /**
   * @deprecated Use /api/chat/v2/sessions/:sessionId/messages instead.
   * This v1 endpoint will be removed in a future release.
   * The v2 endpoint provides enhanced pipeline with structured logging,
   * source citations, suggested follow-ups, and quality scoring.
   */
  app.post("/api/chat/sessions/:id/messages", async (req, res) => {
    try {
      const { id } = req.params;
      const { content } = req.body;

      if (!content || !content.trim()) {
        return res.status(400).json({ message: "Message content is required" });
      }

      const session = await storage.getChatSessionById(id);
      if (!session) {
        return res.status(404).json({ message: "Chat session not found" });
      }

      const userMessage = await storage.createChatMessage({
        sessionId: id,
        role: "user",
        content: content.trim(),
        citations: null,
      });

      const allMessages = await storage.getMessagesBySessionId(id);
      const chatHistory = allMessages
        .filter(m => m.id !== userMessage.id)
        .map(m => ({
          role: m.role,
          content: m.content,
        }));

      let answer: string;
      let citations: string[];
      
      try {
        const result = await askQuestionWithFileSearch({
          question: content.trim(),
          chatHistory,
        });
        answer = result.answer;
        citations = result.citations;
      } catch (aiError) {
        console.error("AI response error:", aiError);
        answer = "An error occurred while processing this question. Please try again in a moment.";
        citations = [];
      }

      const assistantMessage = await storage.createChatMessage({
        sessionId: id,
        role: "assistant",
        content: answer,
        citations: citations.length > 0 ? JSON.stringify(citations) : null,
      });

      if (allMessages.filter(m => m.role === "user").length === 0) {
        const title = content.trim().slice(0, 60) + (content.trim().length > 60 ? "..." : "");
        await storage.updateChatSession(id, { title });
      }

      res.json(assistantMessage);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Failed to send message" 
      });
    }
  });

  // ============================================================
  // TOWN PREFERENCES & RECENT MINUTES UPDATES ROUTES
  // ============================================================

  // Get available towns
  app.get("/api/meta/towns", async (req, res) => {
    try {
      const towns = await storage.getAvailableTowns();
      res.json({ towns });
    } catch (error) {
      console.error("Error fetching available towns:", error);
      res.status(500).json({ message: "Failed to fetch available towns" });
    }
  });
  
  // Get chat configuration (feature flags for frontend)
  app.get("/api/chat/config", (req, res) => {
    // Import chatConfig dynamically to avoid circular dependencies
    const { chatConfig } = require("./chatV2/chatConfig");
    res.json({
      deepAnswerEnabled: chatConfig.DEEP_ANSWER_ENABLED,
    });
  });

  // Set town preference for current actor (authed or anonymous)
  app.post("/api/preferences/town", async (req: IdentityRequest, res) => {
    try {
      const { town } = req.body;

      if (!town || typeof town !== "string") {
        return res.status(400).json({ message: "Town is required" });
      }

      // Validate town is in available list
      const availableTowns = await storage.getAvailableTowns();
      if (!availableTowns.includes(town)) {
        return res.status(400).json({ message: "Invalid town selection" });
      }

      // Build actor identifier from request
      const actor: ActorIdentifier = req.user 
        ? { type: 'user', userId: req.user.id }
        : req.anonId 
          ? { type: 'anon', anonId: req.anonId }
          : { type: 'anon' }; // Fallback for edge case

      // Persist to actor record
      if (actor.userId || actor.anonId) {
        await storage.setActorDefaultTown(actor, town);
      }

      // If there's an active session ID in the request, also set session preference
      const sessionId = req.body.sessionId;
      if (sessionId) {
        await storage.setSessionTownPreference(sessionId, town);
      }

      res.json({ success: true, town });
    } catch (error) {
      console.error("Error setting town preference:", error);
      res.status(500).json({ message: "Failed to set town preference" });
    }
  });

  // Get current town preference for actor
  app.get("/api/preferences/town", async (req: IdentityRequest, res) => {
    try {
      const actor: ActorIdentifier = req.user 
        ? { type: 'user', userId: req.user.id }
        : req.anonId 
          ? { type: 'anon', anonId: req.anonId }
          : { type: 'anon' };

      let town: string | null = null;

      // Check session preference first if sessionId provided
      const sessionId = req.query.sessionId as string | undefined;
      if (sessionId) {
        town = await storage.getSessionTownPreference(sessionId);
      }

      // Fall back to actor default
      if (!town && (actor.userId || actor.anonId)) {
        town = await storage.getActorDefaultTown(actor);
      }

      // Fall back to Ossipee
      town = town || "Ossipee";

      res.json({ town });
    } catch (error) {
      console.error("Error fetching town preference:", error);
      res.status(500).json({ message: "Failed to fetch town preference" });
    }
  });

  // Get recent minutes updates (public)
  app.get("/api/updates/minutes", async (req: IdentityRequest, res) => {
    try {
      let town = req.query.town as string | undefined;
      const limit = parseInt(req.query.limit as string) || 5;

      // If no town specified, resolve from actor preference
      if (!town) {
        const actor: ActorIdentifier = req.user 
          ? { type: 'user', userId: req.user.id }
          : req.anonId 
            ? { type: 'anon', anonId: req.anonId }
            : { type: 'anon' };

        if (actor.userId || actor.anonId) {
          town = await storage.getActorDefaultTown(actor) || undefined;
        }
      }

      // Fallback to Ossipee
      town = town || "Ossipee";

      const items = await storage.getRecentMinutesUpdates({ town, limit });
      res.json({ items });
    } catch (error) {
      console.error("Error fetching recent minutes updates:", error);
      res.status(500).json({ message: "Failed to fetch recent minutes updates" });
    }
  });

  // Get recent minutes updates (admin only, with optional filters)
  app.get(
    "/api/admin/updates/minutes",
    requireRole("admin", "municipal_admin"),
    async (req: IdentityRequest, res) => {
      try {
        const town = req.query.town as string | undefined;
        const board = req.query.board as string | undefined;
        const limit = parseInt(req.query.limit as string) || 50;

        const items = await storage.getRecentMinutesUpdatesAdmin({ town, board, limit });
        res.json({ items });
      } catch (error) {
        console.error("Error fetching admin minutes updates:", error);
        res.status(500).json({ message: "Failed to fetch admin minutes updates" });
      }
    }
  );

  // Register v2 Chat Pipeline Routes
  registerChatV2Routes(app);

  // Register Admin Usage Dashboard Routes
  registerAdminUsageRoutes(app);

  // Register Admin Chat Analytics Routes
  registerAdminChatAnalyticsRoutes(app);

  const httpServer = createServer(app);
  return httpServer;
}
