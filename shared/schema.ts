import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const admins = pgTable("admins", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Legacy documents table - kept for backwards compatibility with existing data
// New uploads will go through the v2 pipeline (FileBlob -> IngestionJob -> DocumentVersion)
export const documents = pgTable("documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  fileSearchFileId: text("file_search_file_id"),
  fileSearchStoreId: text("file_search_store_id"),
  category: text("category"),
  town: text("town"),
  board: text("board"),
  year: integer("year"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// v2 Pipeline Tables

// FileBlob: Represents a physical file with its hashes for deduplication
export const fileBlobs = pgTable("file_blobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  rawHash: text("raw_hash").notNull(), // SHA-256 of full file
  previewHash: text("preview_hash"), // SHA-256 of extracted preview text
  sizeBytes: integer("size_bytes").notNull(),
  mimeType: text("mime_type").notNull(),
  originalFilename: text("original_filename").notNull(),
  storagePath: text("storage_path").notNull(), // local path or storage key
  previewText: text("preview_text"), // extracted text for LLM analysis
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// LogicalDocument: Represents a logical document (e.g., "Conway Zoning Ordinance")
export const logicalDocuments = pgTable("logical_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  canonicalTitle: text("canonical_title").notNull(),
  town: text("town").notNull(), // "statewide" or Town Name
  board: text("board"),
  category: text("category").notNull(),
  currentVersionId: varchar("current_version_id"), // FK to DocumentVersion (set after first version created)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// DocumentVersion: Each upload/indexing of a LogicalDocument creates a version
export const documentVersions = pgTable("document_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull().references(() => logicalDocuments.id, { onDelete: "cascade" }),
  fileBlobId: varchar("file_blob_id").notNull().references(() => fileBlobs.id),
  year: text("year"), // "2024", etc.
  notes: text("notes"),
  fileSearchStoreName: text("file_search_store_name"), // e.g., "fileSearchStores/opencouncil-..."
  fileSearchDocumentName: text("file_search_document_name"), // e.g., "fileSearchStores/.../documents/..."
  isCurrent: boolean("is_current").default(false).notNull(),
  supersedesVersionId: varchar("supersedes_version_id"), // previous version if any
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// IngestionJob: Tracks the staging and review pipeline
export const ingestionJobs = pgTable("ingestion_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileBlobId: varchar("file_blob_id").notNull().references(() => fileBlobs.id),
  status: text("status").notNull().default("staging"), // staging, needs_review, approved, rejected, indexed
  suggestedMetadata: jsonb("suggested_metadata"), // LLM output
  finalMetadata: jsonb("final_metadata"), // after admin edits
  duplicateWarning: text("duplicate_warning"), // notes about potential duplicates
  documentId: varchar("document_id"), // FK to LogicalDocument (set when approved)
  documentVersionId: varchar("document_version_id"), // FK to DocumentVersion (set when indexed)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const chatMessages = pgTable("chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  citations: text("citations"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tempUploads = pgTable("temp_uploads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  filePath: text("file_path").notNull(),
  previewText: text("preview_text"),
  suggestedCategory: text("suggested_category"),
  suggestedTown: text("suggested_town"),
  suggestedBoard: text("suggested_board"),
  suggestedYear: text("suggested_year"),
  suggestedNotes: text("suggested_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Document metadata schema for validation
export const ALLOWED_CATEGORIES = [
  "budget", "zoning", "meeting_minutes", "town_report", "warrant_article",
  "ordinance", "policy", "planning_board_docs", "zba_docs", "licensing_permits",
  "cip", "elections", "misc_other"
] as const;

export const documentMetadataSchema = z.object({
  category: z.enum(ALLOWED_CATEGORIES),
  town: z.string().default(""),
  board: z.string().optional().default(""),
  year: z.string().optional().default(""),
  notes: z.string().optional().default(""),
});

export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;

// Insert schemas
export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  createdAt: true,
});

export const insertFileBlobSchema = createInsertSchema(fileBlobs).omit({
  id: true,
  createdAt: true,
});

export const insertLogicalDocumentSchema = createInsertSchema(logicalDocuments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDocumentVersionSchema = createInsertSchema(documentVersions).omit({
  id: true,
  createdAt: true,
});

export const insertIngestionJobSchema = createInsertSchema(ingestionJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChatSessionSchema = createInsertSchema(chatSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({
  id: true,
  createdAt: true,
});

export const insertAdminSchema = createInsertSchema(admins).omit({
  id: true,
  createdAt: true,
});

export const insertTempUploadSchema = createInsertSchema(tempUploads).omit({
  id: true,
  createdAt: true,
});

// Types
export type Admin = typeof admins.$inferSelect;
export type InsertAdmin = z.infer<typeof insertAdminSchema>;

export type Document = typeof documents.$inferSelect;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;

export type FileBlob = typeof fileBlobs.$inferSelect;
export type InsertFileBlob = z.infer<typeof insertFileBlobSchema>;

export type LogicalDocument = typeof logicalDocuments.$inferSelect;
export type InsertLogicalDocument = z.infer<typeof insertLogicalDocumentSchema>;

export type DocumentVersion = typeof documentVersions.$inferSelect;
export type InsertDocumentVersion = z.infer<typeof insertDocumentVersionSchema>;

export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type InsertIngestionJob = z.infer<typeof insertIngestionJobSchema>;

export type ChatSession = typeof chatSessions.$inferSelect;
export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;

export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;

export type TempUpload = typeof tempUploads.$inferSelect;
export type InsertTempUpload = z.infer<typeof insertTempUploadSchema>;

// Status types for ingestion jobs
export type IngestionJobStatus = "staging" | "needs_review" | "approved" | "rejected" | "indexed";

// Extended types for API responses
export interface IngestionJobWithBlob extends IngestionJob {
  fileBlob: FileBlob;
}

export interface DocumentVersionWithBlob extends DocumentVersion {
  fileBlob: FileBlob;
}

export interface LogicalDocumentWithVersions extends LogicalDocument {
  versions: DocumentVersionWithBlob[];
  currentVersion?: DocumentVersionWithBlob;
}

// Chat V2 Pipeline Types
export type ComplexityLevel = "simple" | "complex";

export interface CriticScore {
  relevance: number;
  completeness: number;
  clarity: number;
  riskOfMisleading: number;
}

export interface SourceCitation {
  id: string;
  title: string;
  town?: string;
  year?: string;
  category?: string;
  url?: string;
}

export interface ChatV2AnswerMeta {
  complexity: ComplexityLevel;
  requiresClarification: boolean;
  criticScore: CriticScore;
  limitationsNote?: string;
}

export interface ChatV2Response {
  message: {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    createdAt: string;
  };
  answerMeta: ChatV2AnswerMeta;
  sources: SourceCitation[];
  suggestedFollowUps: string[];
}
