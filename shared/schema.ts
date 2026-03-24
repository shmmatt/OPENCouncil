import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, serial, boolean, jsonb, numeric, unique, customType } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Custom type for pgvector
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 768})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(",").map(Number);
  },
});

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

// OCR Status enum values
export const OCR_STATUS_VALUES = ['none', 'queued', 'processing', 'completed', 'failed', 'blocked'] as const;
export type OcrStatus = typeof OCR_STATUS_VALUES[number];

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
  // S3 source tracking
  s3Bucket: text("s3_bucket"),
  s3Key: text("s3_key"),
  fileSha256: text("file_sha256"),
  // OCR-related fields
  extractedTextCharCount: integer("extracted_text_char_count").notNull().default(0),
  needsOcr: boolean("needs_ocr").notNull().default(false),
  ocrStatus: text("ocr_status").notNull().default("none"), // 'none' | 'queued' | 'processing' | 'completed' | 'failed' | 'blocked'
  ocrProvider: text("ocr_provider"), // 'textract' | 'tesseract' | 'none'
  ocrFailureReason: text("ocr_failure_reason"),
  ocrText: text("ocr_text"),
  ocrTextCharCount: integer("ocr_text_char_count").notNull().default(0),
  ocrQueuedAt: timestamp("ocr_queued_at"),
  ocrStartedAt: timestamp("ocr_started_at"),
  ocrCompletedAt: timestamp("ocr_completed_at"),
  ocrReindexedAt: timestamp("ocr_reindexed_at"), // When OCR text was re-indexed into RAG
  extractedTextS3Key: text("extracted_text_s3_key"), // S3 key for canonical extracted text artifact
  extractedTextSha256: text("extracted_text_sha256"),
  // Embedding lifecycle tracking
  contentHash: text("content_hash"), // MD5 of the text used for embedding (for change detection, not crypto)
  embeddingStatus: text("embedding_status").notNull().default("none"), // 'none' | 'exported' | 'indexed'
  chunkCount: integer("chunk_count").notNull().default(0),
  embeddedAt: timestamp("embedded_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// OCR Job Status values for the Textract pipeline state machine
export const OCR_JOB_STATUS_VALUES = [
  'queued', 'skipped_native', 'textract_running',
  'textract_failed', 'materialized', 'failed'
] as const;
export type OcrJobStatus = typeof OCR_JOB_STATUS_VALUES[number];

// OcrJobs: Dedicated job queue for Textract OCR pipeline
export const ocrJobs = pgTable("ocr_jobs", {
  id: serial("id").primaryKey(),
  documentId: varchar("document_id").notNull(),
  fileBlobId: varchar("file_blob_id").references(() => fileBlobs.id),
  status: text("status").notNull(), // OcrJobStatus
  priority: integer("priority").notNull().default(0),
  lockedBy: text("locked_by"),
  lockedAt: timestamp("locked_at"),
  availableAt: timestamp("available_at").defaultNow().notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  pageCount: integer("page_count"),
  nativeTextChars: integer("native_text_chars"),
  isPdf: boolean("is_pdf"),
  textractJobId: text("textract_job_id"),
  textractStartedAt: timestamp("textract_started_at"),
  textractCompletedAt: timestamp("textract_completed_at"),
  textractNextToken: text("textract_next_token"),
  s3Bucket: text("s3_bucket"),
  s3Key: text("s3_key"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
  preferredTowns: jsonb("preferred_towns").$type<string[]>().default([]),
  isPaying: boolean("is_paying").default(false).notNull(),
  isMunicipalStaff: boolean("is_municipal_staff").default(false).notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripeSubscriptionStatus: text("stripe_subscription_status"), // 'active' | 'canceled' | 'past_due' | etc.
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

// Situation Context: Tracks the current topic/situation for topic continuity
export interface SituationContext {
  title: string;
  entities: string[];
  timeRange?: { start?: string; end?: string };
  sourceRefs?: string[];
  lastUpdatedAt: string;
}

// Session Source: Ephemeral user-provided content (articles, pasted minutes, etc.)
export interface SessionSource {
  id: string;
  type: "article" | "minutes" | "document" | "paste";
  title?: string;
  text: string;
  createdAt: string;
}

// ============================================================
// DOCUMENT CHAT TEMPLATES
// ============================================================

export interface TemplateSection {
  title: string;
  budgetAmount?: string;
  description: string;
  suggestedQuestions: string[];
}

export interface TemplatePayload {
  summary: string;
  sections: TemplateSection[];
  highLevelQuestions: string[];
}

export const chatTemplates = pgTable("chat_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  slug: text("slug").unique(),
  bannerText: text("banner_text").notNull(),
  town: text("town").notNull(),
  targetDocumentIds: jsonb("target_document_ids").$type<string[]>().notNull().default([]),
  generatedPayload: jsonb("generated_payload").$type<TemplatePayload>(),
  isActive: boolean("is_active").notNull().default(false),
  linkedFeedItemId: varchar("linked_feed_item_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Chat Sessions: Updated with user/anon tracking
export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  userId: varchar("user_id").references(() => users.id),
  anonId: varchar("anon_id").references(() => anonymousUsers.id),
  templateId: varchar("template_id").references(() => chatTemplates.id),
  feedItemId: varchar("feed_item_id"),
  documentVersionId: varchar("document_version_id"),
  townPreference: text("town_preference"),
  situationContext: jsonb("situation_context").$type<SituationContext>(),
  sessionSources: jsonb("session_sources").$type<SessionSource[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const chatMessages = pgTable("chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  citations: text("citations"),
  feedback: text("feedback"),
  attachmentFilename: text("attachment_filename"),
  attachmentMimeType: text("attachment_mime_type"),
  attachmentExtractedText: text("attachment_extracted_text"),
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

// Chat Analytics: LLM-generated analysis of chat sessions for admin review
export const chatAnalytics = pgTable("chat_analytics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }).unique(),
  summary: text("summary").notNull(),
  critique: text("critique").notNull(),
  missingDocsSuggestions: text("missing_docs_suggestions"),
  documentQualityScore: integer("document_quality_score"),
  answerQualityScore: integer("answer_quality_score"),
  gapCategory: text("gap_category"),
  pipelineStage: text("pipeline_stage"),
  criticalDomainError: boolean("critical_domain_error").default(false).notNull(),
  userIntent: text("user_intent"),
  promptingSuggestions: text("prompting_suggestions"),
  pipelineSuggestions: text("pipeline_suggestions"),
  analyzedAt: timestamp("analyzed_at").defaultNow().notNull(),
});

// Chat Review Runs: Aggregated summaries of batch chat analysis runs
export const chatReviewRuns = pgTable("chat_review_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionIds: jsonb("session_ids").$type<string[]>().notNull(),
  totalSessions: integer("total_sessions").notNull(),
  successfulAnalyses: integer("successful_analyses").notNull().default(0),
  avgDocScore: numeric("avg_doc_score"),
  avgAnswerScore: numeric("avg_answer_score"),
  thumbsUpCount: integer("thumbs_up_count").default(0),
  thumbsDownCount: integer("thumbs_down_count").default(0),
  topMissingDocs: text("top_missing_docs"),
  executiveSummary: text("executive_summary"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// DEEP DIVE TABLES
// ============================================================

export const deepDiveSessions = pgTable("deep_dive_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  chatSessionId: varchar("chat_session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  messageId: varchar("message_id").notNull(),
  question: text("question").notNull(),
  town: text("town"),
  status: text("status").notNull().default("running"),
  finalAnswer: text("final_answer"),
  qualityScore: integer("quality_score"),
  completenessScore: integer("completeness_score"),
  iterationCount: integer("iteration_count").notNull().default(0),
  totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 6 }),
  totalDurationMs: integer("total_duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const deepDiveSteps = pgTable("deep_dive_steps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deepDiveId: varchar("deep_dive_id").notNull().references(() => deepDiveSessions.id, { onDelete: "cascade" }),
  stepNumber: integer("step_number").notNull(),
  stepType: text("step_type").notNull(),
  input: text("input").notNull(),
  output: text("output").notNull(),
  reasoning: text("reasoning"),
  toolUsed: text("tool_used"),
  modelUsed: text("model_used"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// S3 to Gemini File Search Sync: Tracks files synced from S3 to Gemini stores
export const s3GeminiSync = pgTable("s3_gemini_sync", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  s3Key: text("s3_key").notNull().unique(), // S3 object key (e.g., conway/minutes/Board/2024/file.pdf)
  geminiStoreId: text("gemini_store_id").notNull(), // Gemini File Search store name
  geminiDocumentId: text("gemini_document_id"), // Gemini document ID after upload
  town: text("town").notNull(), // Extracted town from S3 path
  category: text("category"), // Extracted category (minutes, budget, etc.)
  board: text("board"), // Extracted board name
  year: text("year"), // Extracted year
  sizeBytes: integer("size_bytes"), // File size in bytes
  status: text("status").notNull().default("pending"), // 'pending' | 'synced' | 'failed'
  errorMessage: text("error_message"), // Error message if sync failed
  syncedAt: timestamp("synced_at"), // When the file was successfully synced
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Document metadata schema for validation
export const ALLOWED_CATEGORIES = [
  "budget", "zoning", "meeting_minutes", "town_report", "warrant_article",
  "ordinance", "policy", "planning_board_docs", "zba_docs", "licensing_permits",
  "cip", "elections", "misc_other"
] as const;

export const MEETING_TYPES = ["regular", "special", "work_session"] as const;

// Known NH towns for validation and autocomplete — single source of truth
export const NH_TOWNS = [
  "Acworth", "Albany", "Alexandria", "Allenstown", "Alstead", "Alton", "Amherst",
  "Andover", "Antrim", "Ashland", "Atkinson", "Auburn", "Barnstead", "Barrington",
  "Bartlett", "Bath", "Bedford", "Belmont", "Bennington", "Benton", "Berlin",
  "Bethlehem", "Boscawen", "Bow", "Bradford", "Brentwood", "Bridgewater", "Bristol",
  "Brookfield", "Brookline", "Campton", "Canaan", "Candia", "Canterbury", "Carroll",
  "Center Harbor", "Charlestown", "Chatham", "Chester", "Chesterfield", "Chichester",
  "Claremont", "Clarksville", "Colebrook", "Columbia", "Concord", "Conway", "Cornish",
  "Croydon", "Dalton", "Danbury", "Danville", "Deerfield", "Deering", "Derry",
  "Dorchester", "Dover", "Dublin", "Dummer", "Dunbarton", "Durham", "East Kingston",
  "Easton", "Eaton", "Effingham", "Ellsworth", "Enfield", "Epping", "Epsom", "Errol",
  "Exeter", "Farmington", "Fitzwilliam", "Francestown", "Franconia", "Franklin",
  "Freedom", "Fremont", "Gilford", "Gilmanton", "Gilsum", "Goffstown", "Gorham",
  "Goshen", "Grafton", "Grantham", "Greenfield", "Greenland", "Greenville", "Groton",
  "Hampstead", "Hampton", "Hampton Falls", "Hancock", "Hanover", "Harrisville", "Hart's Location",
  "Haverhill", "Hebron", "Henniker", "Hill", "Hillsborough", "Hinsdale", "Holderness",
  "Hollis", "Hooksett", "Hopkinton", "Hudson", "Jackson", "Jaffrey", "Jefferson",
  "Keene", "Kensington", "Kingston", "Laconia", "Lancaster", "Landaff", "Langdon",
  "Lebanon", "Lee", "Lempster", "Lincoln", "Lisbon", "Litchfield", "Littleton",
  "Londonderry", "Loudon", "Lyman", "Lyme", "Lyndeborough", "Madbury", "Madison",
  "Manchester", "Marlborough", "Marlow", "Mason", "Meredith", "Merrimack", "Middleton",
  "Milan", "Milford", "Milton", "Monroe", "Mont Vernon", "Moultonborough", "Nashua",
  "Nelson", "New Boston", "New Castle", "New Durham", "New Hampton", "New Ipswich",
  "New London", "Newbury", "Newfields", "Newington", "Newmarket", "Newport", "Newton",
  "North Hampton", "Northfield", "Northumberland", "Northwood", "Nottingham", "Orange",
  "Orford", "Ossipee", "Pelham", "Pembroke", "Peterborough", "Piermont", "Pittsburg",
  "Pittsfield", "Plainfield", "Plaistow", "Plymouth", "Portsmouth", "Randolph", "Raymond",
  "Richmond", "Rindge", "Rochester", "Rollinsford", "Roxbury", "Rumney", "Rye",
  "Salem", "Salisbury", "Sanbornton", "Sandown", "Sandwich", "Seabrook", "Sharon",
  "Shelburne", "Somersworth", "South Hampton", "Springfield", "Stark", "Stewartstown",
  "Stoddard", "Strafford", "Stratford", "Stratham", "Sugar Hill", "Sullivan", "Sunapee",
  "Surry", "Sutton", "Swanzey", "Tamworth", "Temple", "Thornton", "Tilton", "Troy",
  "Tuftonboro", "Unity", "Wakefield", "Walpole", "Warner", "Warren", "Washington",
  "Waterville Valley", "Weare", "Webster", "Wentworth", "Westmoreland", "Whitefield",
  "Wilmot", "Wilton", "Winchester", "Windham", "Windsor", "Wolfeboro", "Woodstock",
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

export const insertChatTemplateSchema = createInsertSchema(chatTemplates).omit({
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

export const insertChatAnalyticsSchema = createInsertSchema(chatAnalytics).omit({
  id: true,
  analyzedAt: true,
});

export const insertChatReviewRunSchema = createInsertSchema(chatReviewRuns).omit({
  id: true,
  createdAt: true,
});

export const insertS3GeminiSyncSchema = createInsertSchema(s3GeminiSync).omit({
  id: true,
  createdAt: true,
});

export const insertDeepDiveSessionSchema = createInsertSchema(deepDiveSessions).omit({
  id: true,
  createdAt: true,
});

export const insertDeepDiveStepSchema = createInsertSchema(deepDiveSteps).omit({
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

export type ChatTemplate = typeof chatTemplates.$inferSelect;
export type InsertChatTemplate = z.infer<typeof insertChatTemplateSchema>;

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

export type ChatAnalytics = typeof chatAnalytics.$inferSelect;
export type InsertChatAnalytics = z.infer<typeof insertChatAnalyticsSchema>;

export type ChatReviewRun = typeof chatReviewRuns.$inferSelect;
export type InsertChatReviewRun = z.infer<typeof insertChatReviewRunSchema>;

export type S3GeminiSync = typeof s3GeminiSync.$inferSelect;
export type InsertS3GeminiSync = z.infer<typeof insertS3GeminiSyncSchema>;

export type DeepDiveSession = typeof deepDiveSessions.$inferSelect;
export type InsertDeepDiveSession = z.infer<typeof insertDeepDiveSessionSchema>;

export type DeepDiveStep = typeof deepDiveSteps.$inferSelect;
export type InsertDeepDiveStep = z.infer<typeof insertDeepDiveStepSchema>;

export type DeepDiveStatus = 'running' | 'completed' | 'failed';
export type DeepDiveStepType = 'intent_analysis' | 'research_plan' | 'rag_retrieval' | 'news_search' | 'web_search' | 'llm_reasoning' | 'synthesis' | 'quality_check' | 'supplemental_plan';

// S3 Sync status types
export type S3SyncStatus = 'pending' | 'synced' | 'failed';

// Actor types for identity tracking
export type ActorType = 'user' | 'anon';
export type UserRole = 'user' | 'admin' | 'municipal_admin';
export type LlmStage = 'router' | 'retrievalPlanner' | 'synthesis' | 'followups' | 'simpleAnswer' | 'critic' | 'evidenceGate' | 'deepDive' | 'other';
export type LlmProvider = 'google' | 'openai' | 'other';

// Status types for ingestion jobs
export type IngestionJobStatus = "staging" | "needs_review" | "approved" | "rejected" | "indexed" | "index_failed";

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

// Document Browse API Types
export interface DocumentBrowseItem {
  id: string;            // documentVersionId
  canonicalTitle: string;
  board: string | null;
  category: string;
  meetingDate: string | null; // ISO date string
  previewText: string | null;
  fileBlobId: string;
  town: string;
}

export interface DocumentBrowseResponse {
  items: DocumentBrowseItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ActorIdentifier {
  type: 'user' | 'anon';
  userId?: string;
  anonId?: string;
}

// ============================================================
// PGVECTOR EMBEDDING TABLES
// ============================================================

// Document chunks with embeddings for semantic search
export const documentChunks = pgTable("document_chunks", {
  id: serial("id").primaryKey(),
  documentId: varchar("document_id"),
  fileBlobId: varchar("file_blob_id"),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 768 }),
  metadata: jsonb("metadata").$type<{
    town?: string;
    board?: string;
    year?: number | string;
    date?: string;
    filename?: string;
    documentType?: string;
    fileBlobId?: string;
    contentHash?: string;
  }>(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Embedding generation jobs (tracks batch embedding runs)
export const embeddingJobs = pgTable("embedding_jobs", {
  id: serial("id").primaryKey(),
  documentId: varchar("document_id"),
  fileBlobId: varchar("file_blob_id"),
  batchId: varchar("batch_id"), // groups chunks from a single export run
  status: varchar("status").notNull().default("pending"),
  error: text("error"),
  chunksCount: integer("chunks_count"),
  fileBlobsProcessed: integer("file_blobs_processed"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Insert schemas for embedding tables
export const insertDocumentChunkSchema = createInsertSchema(documentChunks).omit({
  id: true,
  createdAt: true,
});

export const insertEmbeddingJobSchema = createInsertSchema(embeddingJobs).omit({
  id: true,
  createdAt: true,
});

// Types for embedding tables
export type DocumentChunk = typeof documentChunks.$inferSelect;
export type InsertDocumentChunk = z.infer<typeof insertDocumentChunkSchema>;

export type EmbeddingJob = typeof embeddingJobs.$inferSelect;
export type InsertEmbeddingJob = z.infer<typeof insertEmbeddingJobSchema>;

export type EmbeddingJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

// Insert schema and types for OCR jobs
export const insertOcrJobSchema = createInsertSchema(ocrJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type OcrJob = typeof ocrJobs.$inferSelect;
export type InsertOcrJob = z.infer<typeof insertOcrJobSchema>;

// ============================================================
// OC RESEARCH TABLES
// ============================================================

export const RESEARCH_REPORT_STATUS = ['pending', 'processing', 'completed', 'failed'] as const;
export type ResearchReportStatus = typeof RESEARCH_REPORT_STATUS[number];

export const RESEARCH_REPORT_TYPES = ['friction'] as const;
export type ResearchReportType = typeof RESEARCH_REPORT_TYPES[number];

export const SITE_PLAN_OUTCOMES = ['approved', 'approved_with_conditions', 'denied', 'withdrawn', 'abandoned', 'pending', 'unknown'] as const;
export type SitePlanOutcome = typeof SITE_PLAN_OUTCOMES[number];

export const APPEAL_PATHS = ['zba', 'superior_court', 'none', 'unknown'] as const;
export type AppealPath = typeof APPEAL_PATHS[number];

export const PROJECT_TYPES = ['Residential', 'Commercial', 'Mixed-Use'] as const;
export type ProjectType = typeof PROJECT_TYPES[number];

export const APPLICANT_TYPES = ['Citizen/Owner', 'Professional'] as const;
export type ApplicantType = typeof APPLICANT_TYPES[number];

export interface SitePlanApplication {
  entityName: string;
  address?: string;
  applicant?: string;
  initialAppearanceDate?: string;
  lastAppearanceDate?: string;
  totalContinuances: number;
  outcome: SitePlanOutcome;
  conditions?: string[];
  primaryFrictionReason?: string;
  frictionCategories?: string[];
  appealPath: AppealPath;
  appealOutcome?: string;
  meetingReferences: string[];
  projectType?: ProjectType;
  applicantType?: ApplicantType;
}

export interface FunnelStage {
  label: string;
  count: number;
  percentage: number;
  description?: string;
}

export interface FrictionCategory {
  category: string;
  count: number;
  percentage: number;
  examples?: string[];
}

export interface TimeToDecisionData {
  overall: {
    avgDays: number;
    medianDays: number;
    avgContinuances: number;
  };
  byCategory: Array<{
    category: string;
    avgDays: number;
    count: number;
  }>;
}

export interface FrequentFlyerData {
  entityName: string;
  address?: string;
  meetingCount: number;
  totalContinuances: number;
  daysElapsed: number;
  outcome: string;
  frictionCategories: string[];
}

export interface OrdinanceHitListData {
  keyword: string;
  count: number;
  percentage: number;
  exampleProjects: string[];
}

export interface DeveloperScorecardData {
  applicantName: string;
  projectCount: number;
  avgContinuances: number;
  avgDaysToDecision: number;
  approvalRate: number;
  topFrictionCategories: string[];
}

export interface YearlyBreakdown {
  year: number;
  total: number;
  approved: number;
  denied: number;
  withdrawn: number;
  abandoned: number;
  avgDays: number;
  avgContinuances: number;
}

export interface YoYDeltas {
  volumePct: number;
  ttdPct: number;
  continuancesPct: number;
}

export interface TemporalTrendsData {
  yearlyBreakdown: YearlyBreakdown[];
  yoyDeltas: YoYDeltas | null;
}

export interface RepresentationGapGroupStats {
  count: number;
  continuanceRate: number;
  approvalRate: number;
  abandonmentRate: number;
  avgDaysToDecision: number;
}

export interface RepresentationGapData {
  citizenStats: RepresentationGapGroupStats;
  proStats: RepresentationGapGroupStats;
  delta: {
    continuanceRate: number;
    approvalRate: number;
    abandonmentRate: number;
    avgDaysToDecision: number;
  };
}

export interface ProjectTypeGroupStats {
  avgDays: number;
  avgContinuances: number;
  count: number;
  topFriction: string[];
}

export interface ProjectTypeComparisonData {
  residential: ProjectTypeGroupStats;
  commercial: ProjectTypeGroupStats;
  mixedUse: ProjectTypeGroupStats;
}

export interface AttritionCurveEntry {
  stage: string;
  count: number;
  percentage: number;
  description: string;
}

export interface DaysAddedEntry {
  constraint: string;
  avgDaysAdded: number;
  count: number;
}

export interface ApplicationModifiers {
  approvedWithConditions: number;
  approvedAfterDelay: number;
  appealsFiled: number;
  appealSuccesses: number;
}

export interface FrictionReportData {
  townName: string;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  chunksAnalyzed: number;
  batchesProcessed: number;
  documentsAnalyzed?: number;
  rawApplicationCount?: number;
  funnelStages: FunnelStage[];
  applicationModifiers?: ApplicationModifiers;
  frictionMatrix: FrictionCategory[];
  predictiveInsights: string[];
  applications: SitePlanApplication[];
  timeToDecision?: TimeToDecisionData;
  frequentFlyers?: FrequentFlyerData[];
  ordinanceHitList?: OrdinanceHitListData[];
  developerScorecard?: DeveloperScorecardData[];
  temporalTrends?: TemporalTrendsData;
  representationGap?: RepresentationGapData;
  projectTypeComparison?: ProjectTypeComparisonData;
  attritionCurve?: AttritionCurveEntry[];
  daysAddedByConstraint?: DaysAddedEntry[];
}

export const researchReports = pgTable("research_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  townName: text("town_name").notNull(),
  reportType: text("report_type").notNull().default("friction"),
  status: text("status").notNull().default("pending"),
  reportData: jsonb("report_data").$type<FrictionReportData | DynamicReportPayload>(),
  error: text("error"),
  chunksAnalyzed: integer("chunks_analyzed").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  boardType: text("board_type"),
  dateRangeStart: text("date_range_start"),
  dateRangeEnd: text("date_range_end"),
  prompt: text("prompt"),
  documentCount: integer("document_count").default(0),
});

export const insertResearchReportSchema = createInsertSchema(researchReports).omit({
  id: true,
  createdAt: true,
});

export type ResearchReport = typeof researchReports.$inferSelect;
export type InsertResearchReport = z.infer<typeof insertResearchReportSchema>;

// ============================================================
// DYNAMIC REPORT (Universal Municipal Intelligence Engine)
// ============================================================

export const RESEARCH_BOARD_TYPES = ['planning', 'zoning', 'selectboard', 'budget'] as const;
export type ResearchBoardType = typeof RESEARCH_BOARD_TYPES[number];

export type WidgetType = 'summary_text' | 'stat_card' | 'bar_chart';

export interface BaseWidget {
  type: WidgetType;
}

export interface SummaryTextWidget extends BaseWidget {
  type: 'summary_text';
  content: string;
}

export interface StatCardWidget extends BaseWidget {
  type: 'stat_card';
  label: string;
  value: string | number;
  trend?: 'up' | 'down' | 'neutral';
}

export interface BarChartWidget extends BaseWidget {
  type: 'bar_chart';
  title: string;
  xAxisLabel: string;
  data: Array<{ name: string; value: number }>;
}

export type DynamicWidget = SummaryTextWidget | StatCardWidget | BarChartWidget;

export interface DynamicReportPayload {
  reportTitle: string;
  executiveSummary: string;
  widgets: DynamicWidget[];
}

// ============================================================
// CONTENT GENERATION & TOWN FEED
// ============================================================

export interface TownFeedNewsArticle {
  title: string;
  url: string;
  source: string;
  snippet: string;
  fetchedAt: string;
  relevancyScore?: number;
  attribution?: string;
}

export interface ScoredTopic {
  topic: string;
  score: number;
  relevance: number;
  financialImpact: number;
  publicFriction: number;
  qualityOfLife: number;
  board: string | null;
  meetingDate: string | null;
  keyPoints: string[];
  historicalContext?: string;
}

export interface RoutineTopic {
  topic: string;
  score: number;
  board: string | null;
  rollupSentence: string;
}

export interface TownFeedPayload {
  summary: string;
  sections: {
    title: string;
    description: string;
    suggestedQuestions: string[];
  }[];
  highLevelQuestions: string[];
}

export const townFeedItems = pgTable("town_feed_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  town: text("town").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  topics: jsonb("topics").$type<ScoredTopic[]>().notNull().default([]),
  routineTopics: jsonb("routine_topics").$type<RoutineTopic[]>().notNull().default([]),
  sourceMinutesIds: jsonb("source_minutes_ids").$type<string[]>().notNull().default([]),
  newsArticles: jsonb("news_articles").$type<TownFeedNewsArticle[]>().notNull().default([]),
  status: text("status").notNull().default("draft"),
  generatedPayload: jsonb("generated_payload").$type<TownFeedPayload>(),
  templateId: varchar("template_id"),
  publishedAt: timestamp("published_at"),
  upvoteCount: integer("upvote_count").notNull().default(0),
  topicEmoji: varchar("topic_emoji"),
  // Feed automation fields (Task #19)
  feedType: text("feed_type").notNull().default("manual"), // 'manual' | 'automated_digest' | 'automated_feature'
  headerImageUrl: text("header_image_url"), // AI-generated header image for Tier-2 feature articles
  automationSourceVersionId: varchar("automation_source_version_id"), // DocumentVersion that triggered this item
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTownFeedItemSchema = createInsertSchema(townFeedItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type TownFeedItem = typeof townFeedItems.$inferSelect;
export type InsertTownFeedItem = z.infer<typeof insertTownFeedItemSchema>;

// ============================================================
// USER UPVOTES: Track feed item upvotes per user
// ============================================================

export const userUpvotes = pgTable("user_upvotes", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id),
  feedItemId: varchar("feed_item_id").notNull().references(() => townFeedItems.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("user_upvotes_user_feed_unique").on(table.userId, table.feedItemId),
]);

export const insertUserUpvoteSchema = createInsertSchema(userUpvotes).omit({
  id: true,
  createdAt: true,
});

export type UserUpvote = typeof userUpvotes.$inferSelect;
export type InsertUserUpvote = z.infer<typeof insertUserUpvoteSchema>;

// ============================================================
// PROMOTIONS HUB: Omni-channel content & deep links from Town Feed
// ============================================================

export interface PromotionContentMatrix {
  facebookPost: string;
  instagramCaption: string;
  emailSubject: string;
  emailBody: string;
  tiktokScript: string;
  youtubeShortScript: string;
  reelsScript: string;
}

export interface PromotionDeepLink {
  question: string;
  url: string;
}

export const promotions = pgTable("promotions", {
  id: serial("id").primaryKey(),
  feedItemId: varchar("feed_item_id").references(() => townFeedItems.id),
  templateId: varchar("template_id").references(() => chatTemplates.id),
  status: text("status").notNull().default("draft"),
  contentMatrix: jsonb("content_matrix").$type<PromotionContentMatrix>(),
  deepLinks: jsonb("deep_links").$type<PromotionDeepLink[]>().notNull().default([]),
  mediaAssets: jsonb("media_assets").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPromotionSchema = createInsertSchema(promotions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Promotion = typeof promotions.$inferSelect;
export type InsertPromotion = z.infer<typeof insertPromotionSchema>;

// ============================================================
// DOCUMENT GAPS: Auto-flagged missing documents from chat pipeline
// ============================================================

export const documentGaps = pgTable("document_gaps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  town: text("town"),
  description: text("description").notNull(),
  userQuery: text("user_query").notNull(),
  sessionId: varchar("session_id").references(() => chatSessions.id),
  messageId: varchar("message_id"),
  detectionSource: text("detection_source").notNull(),
  recordStrengthTier: text("record_strength_tier"),
  status: text("status").notNull().default("open"),
  hitCount: integer("hit_count").notNull().default(1),
  resolvedAt: timestamp("resolved_at"),
  adminNotes: text("admin_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertDocumentGapSchema = createInsertSchema(documentGaps).omit({
  id: true,
  createdAt: true,
});

export type DocumentGap = typeof documentGaps.$inferSelect;
export type InsertDocumentGap = z.infer<typeof insertDocumentGapSchema>;

// ============================================================
// USER DASHBOARD TABLES
// ============================================================

// User Keywords: Keywords a user wants to watch for in documents
export const userKeywords = pgTable("user_keywords", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  keyword: text("keyword").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserKeywordSchema = createInsertSchema(userKeywords).omit({
  id: true,
  createdAt: true,
});
export type UserKeyword = typeof userKeywords.$inferSelect;
export type InsertUserKeyword = z.infer<typeof insertUserKeywordSchema>;

// Feature Requests: User-submitted feature requests
export const featureRequests = pgTable("feature_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertFeatureRequestSchema = createInsertSchema(featureRequests).omit({
  id: true,
  createdAt: true,
});
export type FeatureRequest = typeof featureRequests.$inferSelect;
export type InsertFeatureRequest = z.infer<typeof insertFeatureRequestSchema>;

// Missing Doc Suggestions: User-submitted suggestions for missing documents
export const missingDocSuggestions = pgTable("missing_doc_suggestions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertMissingDocSuggestionSchema = createInsertSchema(missingDocSuggestions).omit({
  id: true,
  createdAt: true,
});
export type MissingDocSuggestion = typeof missingDocSuggestions.$inferSelect;
export type InsertMissingDocSuggestion = z.infer<typeof insertMissingDocSuggestionSchema>;

// ============================================================
// CRAWLER STATE TABLES (Re-export from crawler-schema.ts)
// ============================================================
export * from './crawler-schema';
