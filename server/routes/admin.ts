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

export default router;
