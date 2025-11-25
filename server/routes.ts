import type { Express } from "express";
import { createServer, type Server } from "http";
import express from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import { storage } from "./storage";
import { authenticateAdmin, generateToken } from "./middleware/auth";
import { uploadDocumentToFileStore, askQuestionWithFileSearch } from "./gemini-client";
import { extractPreviewText, suggestMetadataFromContent } from "./bulk-upload-helper";
import { insertDocumentSchema, insertChatMessageSchema } from "@shared/schema";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";

const ALLOWED_CATEGORIES = [
  "budget", "zoning", "meeting_minutes", "town_report", "warrant_article",
  "ordinance", "policy", "planning_board_docs", "zba_docs", "licensing_permits",
  "cip", "elections", "misc_other"
] as const;

const documentMetadataSchema = z.object({
  category: z.enum(ALLOWED_CATEGORIES),
  town: z.string().optional().transform(v => v?.trim() || ""),
  board: z.string().optional().transform(v => v?.trim() || ""),
  year: z.string().optional().transform(v => {
    const trimmed = v?.trim() || "";
    return /^\d{4}$/.test(trimmed) ? trimmed : "";
  }),
  notes: z.string().optional().transform(v => v?.trim() || ""),
});

export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;

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

export async function registerRoutes(app: Express): Promise<Server> {
  // Admin login with bcrypt authentication
  app.post("/api/admin/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      // Get admin from database
      const admin = await storage.getAdminByEmail(email);

      if (!admin) {
        // Use same error message to prevent email enumeration
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Compare password with bcrypt
      const passwordMatch = await bcrypt.compare(password, admin.passwordHash);

      if (!passwordMatch) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Generate and return JWT token
      const token = generateToken(email);
      return res.json({ token, email });
    } catch (error) {
      console.error("Login error:", error);
      return res.status(500).json({ message: "Login failed" });
    }
  });

  // Get all documents (protected)
  app.get("/api/admin/documents", authenticateAdmin, async (req, res) => {
    try {
      const documents = await storage.getDocuments();
      res.json(documents);
    } catch (error) {
      console.error("Error fetching documents:", error);
      res.status(500).json({ message: "Failed to fetch documents" });
    }
  });

  // Upload document (protected)
  app.post(
    "/api/admin/documents/upload",
    authenticateAdmin,
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ message: "No file uploaded" });
        }

        // Parse and validate metadata JSON
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

        // Upload to Gemini File Search with validated metadata
        const { fileId, storeId } = await uploadDocumentToFileStore(
          req.file.path,
          req.file.originalname,
          parsedMetadata
        );

        // Save document metadata to database
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

        // Clean up uploaded file
        await fs.unlink(req.file.path);

        res.json(document);
      } catch (error) {
        console.error("Error uploading document:", error);
        // Clean up file on error
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
      
      // Get document to delete the file
      const document = await storage.getDocumentById(id);
      if (document) {
        // Try to delete the physical file if it exists
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

  // Bulk upload - Analyze files and suggest metadata (protected)
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

  // Bulk upload - Finalize and upload to File Search (protected)
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

  // Get all chat sessions
  app.get("/api/chat/sessions", async (req, res) => {
    try {
      const sessions = await storage.getChatSessions();
      res.json(sessions);
    } catch (error) {
      console.error("Error fetching sessions:", error);
      res.status(500).json({ message: "Failed to fetch sessions" });
    }
  });

  // Create new chat session
  app.post("/api/chat/sessions", async (req, res) => {
    try {
      const { title } = req.body;
      const session = await storage.createChatSession({
        title: title || "New conversation",
      });
      res.json(session);
    } catch (error) {
      console.error("Error creating session:", error);
      res.status(500).json({ message: "Failed to create session" });
    }
  });

  // Get messages for a session
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

  // Send message and get AI response
  app.post("/api/chat/sessions/:id/messages", async (req, res) => {
    try {
      const { id } = req.params;
      const { content } = req.body;

      if (!content || !content.trim()) {
        return res.status(400).json({ message: "Message content is required" });
      }

      // Verify session exists
      const session = await storage.getChatSessionById(id);
      if (!session) {
        return res.status(404).json({ message: "Chat session not found" });
      }

      // Save user message
      const userMessage = await storage.createChatMessage({
        sessionId: id,
        role: "user",
        content: content.trim(),
        citations: null,
      });

      // Get chat history for context (excluding the message we just added)
      const allMessages = await storage.getMessagesBySessionId(id);
      const chatHistory = allMessages
        .filter(m => m.id !== userMessage.id)
        .map(m => ({
          role: m.role,
          content: m.content,
        }));

      // Get AI response with File Search (with error handling)
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
        answer = "I apologize, but I encountered an error while processing your question. Please try again or contact support if the issue persists.";
        citations = [];
      }

      // Save assistant message
      const assistantMessage = await storage.createChatMessage({
        sessionId: id,
        role: "assistant",
        content: answer,
        citations: citations.length > 0 ? JSON.stringify(citations) : null,
      });

      // Update session title if this is the first message exchange
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

  const httpServer = createServer(app);
  return httpServer;
}
