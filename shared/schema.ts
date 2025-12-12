import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, jsonb, numeric, unique } from "drizzle-orm/pg-core";
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
  geminiDisplayName: text("gemini_display_name"), // Display name sent to Gemini (for citation matching)
  isCurrent: boolean("is_current").default(false).notNull(),
  supersedesVersionId: varchar("supersedes_version_id"), // previous version if any
  // Minutes-specific fields
  meetingDate: timestamp("meeting_date"), // parsed date for meeting minutes
  isMinutes: boolean("is_minutes").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// IngestionJob: Tracks the staging and review pipeline
export const ingestionJobs = pgTable("ingestion_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileBlobId: varchar("file_blob_id").notNull().references(() => fileBlobs.id),
  status: text("status").notNull().default("staging"), // staging, needs_review, approved, rejected, indexed
  suggestedMetadata: jsonb("suggested_metadata"), // LLM output
  finalMetadata: jsonb("final_metadata"), // after admin edits
  metadataHints: jsonb("metadata_hints"), // hints from upload (defaultTown, defaultBoard)
  duplicateWarning: text("duplicate_warning"), // notes about potential duplicates
  statusNote: text("status_note"), // notes about why job has a certain status (e.g., "No town detected")
  documentId: varchar("document_id"), // FK to LogicalDocument (set when approved)
  documentVersionId: varchar("document_version_id"), // FK to DocumentVersion (set when indexed)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================
// IDENTITY SPINE TABLES
// ============================================================

// Users: Core user identity table
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  role: text("role").notNull().default("user"), // 'user' | 'admin' | 'municipal_admin'
  defaultTown: text("default_town"),
  isPaying: boolean("is_paying").default(false).notNull(),
  isMunicipalStaff: boolean("is_municipal_staff").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at"),
});

// User Identities: Maps external identifiers to users
export const userIdentities = pgTable("user_identities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // 'email' | 'magic_link' | 'google' | 'municipal_sso'
  providerKey: text("provider_key").notNull(), // email address or SSO subject
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("user_identities_provider_key_unique").on(table.provider, table.providerKey),
]);

// Anonymous Users: Tracks anonymous visitors
export const anonymousUsers = pgTable("anonymous_users", {
  id: varchar("id").primaryKey(), // UUID from cookie (not auto-generated)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  userId: varchar("user_id").references(() => users.id), // Linked when user signs up
  defaultTown: text("default_town"), // Town preference for anonymous users
});

// Chat Sessions: Updated with user/anon tracking
export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  userId: varchar("user_id").references(() => users.id),
  anonId: varchar("anon_id").references(() => anonymousUsers.id),
  townPreference: text("town_preference"), // Session-level town preference override
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

// ============================================================
// LLM COST LOGGING & EVENTS TABLES
// ============================================================

// LLM Cost Logs: Per-LLM-call cost tracking
export const llmCostLogs = pgTable("llm_cost_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  actorType: text("actor_type").notNull(), // 'user' | 'anon'
  userId: varchar("user_id").references(() => users.id),
  anonId: varchar("anon_id").references(() => anonymousUsers.id),
  sessionId: varchar("session_id").references(() => chatSessions.id),
  requestId: text("request_id"), // Correlates to a single HTTP request
  stage: text("stage").notNull(), // 'router' | 'retrievalPlanner' | 'synthesis' | 'followups' | 'other'
  provider: text("provider").notNull(), // 'openai' | 'google' | etc.
  model: text("model").notNull(), // 'gemini-2.5-flash' | 'gpt-5.1' | etc.
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(), // Up to 6 decimal places
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Events: Generic event tracking for analytics and audience targeting
export const events = pgTable("events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  actorType: text("actor_type").notNull(), // 'user' | 'anon'
  userId: varchar("user_id").references(() => users.id),
  anonId: varchar("anon_id").references(() => anonymousUsers.id),
  eventType: text("event_type").notNull(), // 'chat_message', 'session_created', 'scope_change', etc.
  sessionId: varchar("session_id").references(() => chatSessions.id),
  town: text("town"),
  board: text("board"),
  topic: text("topic"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Document metadata schema for validation
export const ALLOWED_CATEGORIES = [
  "budget", "zoning", "meeting_minutes", "town_report", "warrant_article",
  "ordinance", "policy", "planning_board_docs", "zba_docs", "licensing_permits",
  "cip", "elections", "misc_other"
] as const;

export const MEETING_TYPES = ["regular", "special", "work_session"] as const;

// Known NH towns for validation and autocomplete
export const NH_TOWNS = [
  "Ossipee", "Conway", "Madison", "Freedom", "Tamworth", "Albany", "Sandwich",
  "Jackson", "Bartlett", "Eaton", "Effingham", "Moultonborough", "Tuftonboro",
  "Wolfeboro", "Wakefield", "Brookfield", "Chatham", "Hart's Location",
  "statewide" // special value for statewide documents
] as const;

export const documentMetadataSchema = z.object({
  category: z.enum(ALLOWED_CATEGORIES),
  town: z.string().default(""),
  board: z.string().optional().default(""),
  year: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  // Minutes-specific metadata
  isMinutes: z.boolean().optional().default(false),
  meetingDate: z.string().nullable().optional().default(null), // ISO date: "2024-03-05"
  meetingType: z.string().nullable().optional().default(null), // "regular", "special", "work_session"
  rawDateText: z.string().nullable().optional().default(null), // original text e.g. "March 5, 2024"
});

export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;

// Schema for metadata hints provided during upload
export const metadataHintsSchema = z.object({
  defaultTown: z.string().optional(),
  defaultBoard: z.string().optional(),
});

export type MetadataHints = z.infer<typeof metadataHintsSchema>;

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

// Identity spine insert schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertUserIdentitySchema = createInsertSchema(userIdentities).omit({
  id: true,
  createdAt: true,
});

export const insertAnonymousUserSchema = createInsertSchema(anonymousUsers).omit({
  createdAt: true,
});

export const insertLlmCostLogSchema = createInsertSchema(llmCostLogs).omit({
  id: true,
  createdAt: true,
});

export const insertEventSchema = createInsertSchema(events).omit({
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

// Identity spine types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type UserIdentity = typeof userIdentities.$inferSelect;
export type InsertUserIdentity = z.infer<typeof insertUserIdentitySchema>;

export type AnonymousUser = typeof anonymousUsers.$inferSelect;
export type InsertAnonymousUser = z.infer<typeof insertAnonymousUserSchema>;

export type LlmCostLog = typeof llmCostLogs.$inferSelect;
export type InsertLlmCostLog = z.infer<typeof insertLlmCostLogSchema>;

export type Event = typeof events.$inferSelect;
export type InsertEvent = z.infer<typeof insertEventSchema>;

// Actor types for identity tracking
export type ActorType = 'user' | 'anon';
export type UserRole = 'user' | 'admin' | 'municipal_admin';
export type LlmStage = 'router' | 'retrievalPlanner' | 'synthesis' | 'followups' | 'simpleAnswer' | 'critic' | 'other';
export type LlmProvider = 'google' | 'openai' | 'other';

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

// Town/Minutes Updates Types
export interface MinutesUpdateItem {
  logicalDocumentId: string;
  documentVersionId: string;
  town: string;
  board: string | null;
  category: string;
  meetingDate: string | null; // ISO date string
  ingestedAt: string; // ISO date string from dv.createdAt
  fileSearchDocumentName: string | null;
}

export interface ActorIdentifier {
  type: 'user' | 'anon';
  userId?: string;
  anonId?: string;
}
