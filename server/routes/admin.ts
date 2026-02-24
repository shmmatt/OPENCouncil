import { Router } from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { storage } from "../storage";
import { authenticateAdmin, generateToken } from "../middleware/auth";
import { uploadDocumentToFileStore } from "../gemini-client";
import { extractPreviewText, suggestMetadataFromContent } from "../bulk-upload-helper";
import { documentMetadataSchema } from "@shared/schema";
import type { DocumentMetadata } from "@shared/schema";
import { startPipeline, getProgress, requestStop, isRunning } from "../services/embeddingPipeline";

const router = Router();

const upload = multer({
  dest: "uploads/",
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

router.post("/login", async (req, res) => {
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

router.get("/documents", authenticateAdmin, async (req, res) => {
  try {
    const documents = await storage.getDocuments();
    res.json(documents);
  } catch (error) {
    console.error("Error fetching documents:", error);
    res.status(500).json({ message: "Failed to fetch documents" });
  }
});

router.post(
  "/documents/upload",
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

router.delete("/documents/:id", authenticateAdmin, async (req, res) => {
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

router.post(
  "/bulk-upload/analyze",
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

router.post("/bulk-upload/finalize", authenticateAdmin, async (req, res) => {
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

router.get("/v2/documents", authenticateAdmin, async (req, res) => {
  try {
    const documents = await storage.getLogicalDocuments();
    res.json(documents);
  } catch (error) {
    console.error("Error fetching logical documents:", error);
    res.status(500).json({ message: "Failed to fetch documents" });
  }
});

router.get("/unified-documents", authenticateAdmin, async (req, res) => {
  try {
    const { db, sql: sqlTag } = await import("../storage/db");
    const town = (req.query.town as string) || "";
    const q = (req.query.q as string) || "";
    const ids = req.query.ids as string | undefined;

    if (ids) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const idList = ids.split(",").filter(id => uuidRegex.test(id));
      if (idList.length === 0) return res.json([]);

      const logicalResult = await db.execute(sqlTag`
        SELECT ld.id, ld.canonical_title as title, ld.town, 'logical' as source
        FROM logical_documents ld
        WHERE ld.id IN (${sqlTag.join(idList.map(id => sqlTag`${id}`), sqlTag`, `)})
      `);
      const crawlerResult = await db.execute(sqlTag`
        SELECT fb.id, COALESCE(cd.filename, fb.original_filename) as title, ct.name as town, 'crawler' as source
        FROM file_blobs fb
        JOIN crawler_documents cd ON cd.file_blob_id = fb.id
        JOIN crawler_towns ct ON cd.town_id = ct.id
        WHERE fb.id IN (${sqlTag.join(idList.map(id => sqlTag`${id}`), sqlTag`, `)})
      `);
      const logicalDocs = (logicalResult.rows || logicalResult || []) as any[];
      const crawlerDocs = (crawlerResult.rows || crawlerResult || []) as any[];
      const seen = new Set(logicalDocs.map((d: any) => d.id));
      const unified = [
        ...logicalDocs.map((d: any) => ({ id: d.id, title: d.title, town: d.town, source: "logical" as const })),
        ...crawlerDocs.filter((d: any) => !seen.has(d.id)).map((d: any) => ({ id: d.id, title: d.title, town: d.town, source: "crawler" as const })),
      ];
      return res.json(unified);
    }

    if (!q && !town) {
      return res.json([]);
    }

    const searchPattern = q ? `%${q}%` : "%";

    const logicalResult = await db.execute(sqlTag`
      SELECT ld.id, ld.canonical_title as title, ld.town, 'logical' as source
      FROM logical_documents ld
      WHERE ld.canonical_title IS NOT NULL
        AND lower(ld.canonical_title) LIKE lower(${searchPattern})
        AND (${town} = '' OR ld.town = ${town})
      ORDER BY ld.canonical_title
      LIMIT 25
    `);

    const crawlerResult = await db.execute(sqlTag`
      SELECT DISTINCT ON (fb.id) fb.id, COALESCE(cd.filename, fb.original_filename) as title, ct.name as town, 'crawler' as source
      FROM file_blobs fb
      JOIN crawler_documents cd ON cd.file_blob_id = fb.id
      JOIN crawler_towns ct ON cd.town_id = ct.id
      WHERE fb.id NOT IN (
        SELECT dv.file_blob_id FROM document_versions dv
        JOIN logical_documents ld2 ON ld2.current_version_id = dv.id
        WHERE dv.file_blob_id IS NOT NULL
      )
      AND (fb.preview_text IS NOT NULL OR fb.ocr_text IS NOT NULL)
      AND lower(COALESCE(cd.filename, fb.original_filename)) LIKE lower(${searchPattern})
      AND (${town} = '' OR ct.name = ${town})
      ORDER BY fb.id, COALESCE(cd.filename, fb.original_filename)
      LIMIT 25
    `);

    const logicalDocs = (logicalResult.rows || logicalResult || []) as any[];
    const crawlerDocs = (crawlerResult.rows || crawlerResult || []) as any[];

    const unified = [
      ...logicalDocs.map((d: any) => ({ id: d.id, title: d.title, town: d.town, source: "logical" as const })),
      ...crawlerDocs.map((d: any) => ({ id: d.id, title: d.title, town: d.town, source: "crawler" as const })),
    ];

    res.json(unified);
  } catch (error) {
    console.error("Error fetching unified documents:", error);
    res.status(500).json({ message: "Failed to fetch unified documents" });
  }
});

router.get("/v2/documents/:id", authenticateAdmin, async (req, res) => {
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

router.get("/v2/documents/search", authenticateAdmin, async (req, res) => {
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

router.get("/pipeline-status", authenticateAdmin, async (_req, res) => {
  try {
    const { db, sql: sqlTag } = await import("../storage/db");

    const crawlerResult = await db.execute(sqlTag`
      SELECT 
        count(*) as total_discovered,
        count(file_blob_id) as linked_to_blobs,
        count(CASE WHEN status = 'uploaded' THEN 1 END) as uploaded
      FROM crawler_documents
    `);
    const crawlerStats = crawlerResult.rows?.[0] || crawlerResult[0] || {};

    const fileBlobResult = await db.execute(sqlTag`
      SELECT
        count(*) as total_blobs,
        count(CASE WHEN ocr_status = 'completed' OR (COALESCE(char_length(preview_text), 0) >= 1000) THEN 1 END) as text_ready,
        count(CASE WHEN ocr_status = 'completed' THEN 1 END) as ocr_completed,
        count(CASE WHEN ocr_status = 'processing' OR ocr_status = 'queued' THEN 1 END) as ocr_pending,
        count(CASE WHEN ocr_status = 'failed' OR ocr_status = 'blocked' THEN 1 END) as ocr_failed,
        count(CASE WHEN embedding_status = 'none' AND (ocr_text IS NOT NULL OR (preview_text IS NOT NULL AND char_length(preview_text) >= 100)) THEN 1 END) as ready_to_export,
        count(CASE WHEN embedding_status = 'exported' THEN 1 END) as exported,
        count(CASE WHEN embedding_status = 'indexed' THEN 1 END) as indexed,
        COALESCE(sum(CASE WHEN embedding_status = 'indexed' THEN chunk_count ELSE 0 END), 0) as total_indexed_chunks
      FROM file_blobs
    `);
    const fileBlobStats = fileBlobResult.rows?.[0] || fileBlobResult[0] || {};

    const chunkResult = await db.execute(sqlTag`
      SELECT 
        count(*) as total_chunks,
        count(file_blob_id) as chunks_with_lineage,
        count(DISTINCT file_blob_id) as unique_blobs_in_chunks
      FROM document_chunks
    `);
    const chunkStats = chunkResult.rows?.[0] || chunkResult[0] || {};

    const versionResult = await db.execute(sqlTag`
      SELECT
        count(*) as total_versions,
        count(CASE WHEN is_current = true THEN 1 END) as current_versions
      FROM document_versions
    `);
    const versionStats = versionResult.rows?.[0] || versionResult[0] || {};

    const logicalDocResult = await db.execute(sqlTag`
      SELECT count(*) as total_logical_docs FROM logical_documents
    `);
    const logicalDocStats = logicalDocResult.rows?.[0] || logicalDocResult[0] || {};

    const embeddingJobResult = await db.execute(sqlTag`
      SELECT id, batch_id, status, chunks_count, file_blobs_processed, started_at, completed_at
      FROM embedding_jobs
      ORDER BY created_at DESC
      LIMIT 10
    `);
    const embeddingJobRows = embeddingJobResult.rows || embeddingJobResult || [];

    const embStatusResult = await db.execute(sqlTag`
      SELECT embedding_status, count(*) as count
      FROM file_blobs
      GROUP BY embedding_status
      ORDER BY count DESC
    `);
    const embeddingStatusBreakdown = embStatusResult.rows || embStatusResult || [];

    const ocrStatusResult = await db.execute(sqlTag`
      SELECT ocr_status, count(*) as count
      FROM file_blobs
      GROUP BY ocr_status
      ORDER BY count DESC
    `);
    const ocrStatusBreakdown = ocrStatusResult.rows || ocrStatusResult || [];

    res.json({
      pipeline: {
        discovered: Number(crawlerStats?.total_discovered || 0),
        downloaded: Number(crawlerStats?.uploaded || 0),
        linkedToBlobs: Number(crawlerStats?.linked_to_blobs || 0),
        totalBlobs: Number(fileBlobStats?.total_blobs || 0),
        textReady: Number(fileBlobStats?.text_ready || 0),
        ocrCompleted: Number(fileBlobStats?.ocr_completed || 0),
        ocrPending: Number(fileBlobStats?.ocr_pending || 0),
        ocrFailed: Number(fileBlobStats?.ocr_failed || 0),
        readyToExport: Number(fileBlobStats?.ready_to_export || 0),
        exported: Number(fileBlobStats?.exported || 0),
        indexed: Number(fileBlobStats?.indexed || 0),
        totalIndexedChunks: Number(fileBlobStats?.total_indexed_chunks || 0),
        totalChunksInPgvector: Number(chunkStats?.total_chunks || 0),
        chunksWithLineage: Number(chunkStats?.chunks_with_lineage || 0),
        uniqueBlobsInChunks: Number(chunkStats?.unique_blobs_in_chunks || 0),
        totalLogicalDocs: Number(logicalDocStats?.total_logical_docs || 0),
        totalVersions: Number(versionStats?.total_versions || 0),
        currentVersions: Number(versionStats?.current_versions || 0),
      },
      breakdowns: {
        embeddingStatus: embeddingStatusBreakdown,
        ocrStatus: ocrStatusBreakdown,
      },
      recentJobs: embeddingJobRows,
    });
  } catch (error) {
    console.error("Error fetching pipeline status:", error);
    res.status(500).json({ message: "Failed to fetch pipeline status" });
  }
});

router.post("/embedding/start", authenticateAdmin, async (req, res) => {
  try {
    if (isRunning()) {
      return res.status(409).json({ message: "Embedding pipeline is already running" });
    }

    const { limit, town } = req.body || {};

    startPipeline({
      limit: limit ? Number(limit) : undefined,
      town: town || undefined,
    }).catch(err => {
      console.error("Embedding pipeline background error:", err);
    });

    await new Promise(resolve => setTimeout(resolve, 200));
    const progress = getProgress();

    res.json({
      message: "Embedding pipeline started",
      batchId: progress.batchId,
      progress,
    });
  } catch (error: any) {
    console.error("Error starting embedding pipeline:", error);
    res.status(500).json({ message: error.message || "Failed to start embedding pipeline" });
  }
});

router.get("/embedding/status", authenticateAdmin, async (_req, res) => {
  try {
    const progress = getProgress();
    res.json(progress);
  } catch (error) {
    console.error("Error fetching embedding status:", error);
    res.status(500).json({ message: "Failed to fetch embedding status" });
  }
});

router.post("/embedding/stop", authenticateAdmin, async (_req, res) => {
  try {
    const stopped = requestStop();
    if (stopped) {
      res.json({ message: "Stop requested. Pipeline will finish current batch and stop." });
    } else {
      res.status(400).json({ message: "Pipeline is not currently running" });
    }
  } catch (error) {
    console.error("Error stopping embedding pipeline:", error);
    res.status(500).json({ message: "Failed to stop embedding pipeline" });
  }
});

export default router;
