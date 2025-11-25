import type { Express } from "express";
import { createServer, type Server } from "http";
import express from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import { storage } from "./storage";
import { authenticateAdmin, generateToken } from "./middleware/auth";
import { uploadDocumentToFileStore, askQuestionWithFileSearch } from "./gemini-client";
import { insertDocumentSchema, insertChatMessageSchema } from "@shared/schema";
import * as fs from "fs/promises";
import * as path from "path";

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

        const { category, town, board, year, notes } = req.body;

        // Upload to Gemini File Search
        const { fileId, storeId } = await uploadDocumentToFileStore(
          req.file.path,
          req.file.originalname,
          {
            category: category || "",
            town: town || "",
            board: board || "",
            year: year || "",
          }
        );

        // Save document metadata to database
        const document = await storage.createDocument({
          filename: req.file.filename,
          originalName: req.file.originalname,
          fileSearchFileId: fileId,
          fileSearchStoreId: storeId,
          category: category || null,
          town: town || null,
          board: board || null,
          year: year ? parseInt(year) : null,
          notes: notes || null,
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
