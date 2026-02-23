import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ============================================================
// CRAWLER STATE MANAGEMENT TABLES
// ============================================================

/**
 * Crawler Towns: Master registry of all towns being crawled
 * Tracks metadata, CMS type, last crawl status, etc.
 */
export const crawlerTowns = pgTable("crawler_towns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(), // "Conway", "Ossipee", etc.
  slug: text("slug").notNull().unique(), // "conway", "ossipee" (lowercase, no spaces)
  url: text("url").notNull(), // Base URL: https://conwaynh.gov
  cms: text("cms"), // "CivicPlus" | "WordPress" | "Revize" | "Custom" | null
  county: text("county"), // "Carroll", "Strafford", etc.
  state: text("state").notNull().default("NH"),
  population: integer("population"),
  
  // Crawl status
  status: text("status").notNull().default("active"), // "active" | "failed" | "paused" | "disabled"
  lastFullCrawl: timestamp("last_full_crawl"), // Last successful full crawl
  lastIncrementalCrawl: timestamp("last_incremental_crawl"), // Last incremental update
  nextScheduledCrawl: timestamp("next_scheduled_crawl"), // For weekly scheduler
  
  // Stats
  totalDocuments: integer("total_documents").notNull().default(0), // Total docs ever discovered
  totalUploaded: integer("total_uploaded").notNull().default(0), // Total uploaded to S3
  lastCrawlDocsFound: integer("last_crawl_docs_found").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  
  // Configuration overrides (optional)
  maxPages: integer("max_pages"), // Override default max pages for this town
  customPaths: jsonb("custom_paths").$type<string[]>(), // Manual paths to crawl
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Crawler Sitemaps: Tracks sitemap snapshots and URLs
 * Enables sitemap diffing for incremental crawls
 */
export const crawlerSitemaps = pgTable("crawler_sitemaps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  townId: varchar("town_id").notNull().references(() => crawlerTowns.id, { onDelete: "cascade" }),
  
  // Sitemap metadata
  sitemapUrl: text("sitemap_url").notNull(), // Usually {baseUrl}/sitemap.xml
  hash: text("hash").notNull(), // SHA-256 of sitemap XML content
  urlCount: integer("url_count").notNull().default(0),
  
  // Snapshot
  urls: jsonb("urls").notNull().$type<SitemapUrl[]>(), // Array of URLs with metadata
  
  // Timing
  discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
  lastChecked: timestamp("last_checked").defaultNow().notNull(),
});

/**
 * Crawler URLs: Individual URL tracking for visit history
 * Separate from sitemap for pages discovered via navigation
 */
export const crawlerUrls = pgTable("crawler_urls", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  townId: varchar("town_id").notNull().references(() => crawlerTowns.id, { onDelete: "cascade" }),
  
  url: text("url").notNull(), // Full URL
  urlHash: text("url_hash").notNull(), // SHA-256 for deduplication
  
  // Classification
  source: text("source").notNull(), // "sitemap" | "navigation" | "custom" | "deep_link"
  priority: text("priority").notNull().default("medium"), // "high" | "medium" | "low"
  
  // Visit tracking
  firstDiscovered: timestamp("first_discovered").defaultNow().notNull(),
  lastVisited: timestamp("last_visited"),
  visitCount: integer("visit_count").notNull().default(0),
  documentCount: integer("document_count").notNull().default(0), // Docs found on this page
  
  // Status
  status: text("status").notNull().default("pending"), // "pending" | "visited" | "failed"
  errorMessage: text("error_message"),
});

/**
 * Crawler Documents: Registry of all discovered documents
 * Tracks discovery, upload, and sync status
 */
export const crawlerDocuments = pgTable("crawler_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  townId: varchar("town_id").notNull().references(() => crawlerTowns.id, { onDelete: "cascade" }),
  
  // Document identity
  url: text("url").notNull(), // Source URL
  urlHash: text("url_hash").notNull().unique(), // SHA-256 for deduplication
  filename: text("filename").notNull(), // Final filename
  
  // Metadata (extracted from URL/path)
  category: text("category"), // "minutes", "agendas", "budget", etc.
  board: text("board"), // "Board_of_Selectmen", "Planning_Board", etc.
  year: text("year"), // "2024", etc.
  
  // File info
  sizeBytes: integer("size_bytes"),
  mimeType: text("mime_type"),
  
  // S3 tracking
  s3Key: text("s3_key"), // conway/minutes/Board/2024/file.pdf
  s3UploadedAt: timestamp("s3_uploaded_at"),
  
  // Discovery & status
  discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
  discoveredFrom: text("discovered_from"), // URL where we found this link
  status: text("status").notNull().default("discovered"), // "discovered" | "downloaded" | "uploaded" | "failed"
  errorMessage: text("error_message"),
  
  // Verification
  contentValidated: boolean("content_validated").notNull().default(false),
  lastVerified: timestamp("last_verified"),
  
  // Relations
  s3SyncId: varchar("s3_sync_id"), // FK to s3_gemini_sync (if synced to Gemini)
  fileBlobId: varchar("file_blob_id"), // FK to file_blobs (linked after download)
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Crawler Runs: Historical record of each crawl execution
 * For debugging, analytics, and progress tracking
 */
export const crawlerRuns = pgTable("crawler_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  townId: varchar("town_id").notNull().references(() => crawlerTowns.id, { onDelete: "cascade" }),
  
  // Run metadata
  mode: text("mode").notNull(), // "full" | "incremental" | "manual"
  triggerType: text("trigger_type").notNull(), // "scheduled" | "manual" | "retry"
  
  // Execution
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("running"), // "running" | "completed" | "failed" | "timeout"
  
  // Stats
  pagesVisited: integer("pages_visited").notNull().default(0),
  documentsDiscovered: integer("documents_discovered").notNull().default(0),
  documentsDownloaded: integer("documents_downloaded").notNull().default(0),
  documentsUploaded: integer("documents_uploaded").notNull().default(0),
  documentsFailed: integer("documents_failed").notNull().default(0),
  
  // Configuration snapshot
  maxPagesLimit: integer("max_pages_limit"),
  resumedFromCheckpoint: boolean("resumed_from_checkpoint").notNull().default(false),
  
  // Results
  errorMessage: text("error_message"),
  summary: jsonb("summary"), // Detailed stats, by category, etc.
  
  // Logs
  logPath: text("log_path"),
  logs: jsonb("logs").$type<string[]>(),
});

/**
 * Crawl Assessments: Cached quality/completeness scores per town
 * Compares predicted document counts (based on population) against
 * LLM-estimated counts (from analyzing downloaded filenames)
 */
export const crawlAssessments = pgTable("crawl_assessments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  townId: varchar("town_id").notNull().references(() => crawlerTowns.id, { onDelete: "cascade" }),
  assessedAt: timestamp("assessed_at").defaultNow().notNull(),

  population: integer("population"),

  predicted: jsonb("predicted").notNull().default({}).$type<CategoryCounts>(),
  estimated: jsonb("estimated").notNull().default({}).$type<CategoryCounts>(),
  categoryScores: jsonb("category_scores").notNull().default({}).$type<CategoryScores>(),
  overallScore: numeric("overall_score", { precision: 5, scale: 2 }).notNull().default("0"),

  totalFilesAnalyzed: integer("total_files_analyzed").notNull().default(0),
  llmModel: text("llm_model"),
  notes: text("notes"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// TYPES & SCHEMAS
// ============================================================

export const DOCUMENT_CATEGORIES = [
  "meeting_minutes",
  "agendas",
  "ordinances",
  "budgets",
  "annual_reports",
  "forms_applications",
  "newsletters",
  "zoning",
  "plans_studies",
  "policies_procedures",
  "elections",
  "other",
] as const;

export type DocumentCategory = typeof DOCUMENT_CATEGORIES[number];

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  meeting_minutes: "Meeting Minutes",
  agendas: "Agendas",
  ordinances: "Ordinances & Regulations",
  budgets: "Budgets & Financial",
  annual_reports: "Annual/Town Reports",
  forms_applications: "Forms & Applications",
  newsletters: "Newsletters & Notices",
  zoning: "Zoning Documents",
  plans_studies: "Plans & Studies",
  policies_procedures: "Policies & Procedures",
  elections: "Elections & Voting",
  other: "Other Documents",
};

export type CategoryCounts = Record<DocumentCategory, number>;
export type CategoryScores = Record<DocumentCategory, {
  predicted: number;
  estimated: number;
  score: number;
  rating: "excellent" | "good" | "fair" | "poor" | "missing";
}>;

export interface SitemapUrl {
  url: string;
  priority: "high" | "medium" | "low";
  discovered: string; // ISO timestamp
  lastVisited?: string; // ISO timestamp
  docCount: number;
}

export const FAILURE_TYPES = [
  "http_404",
  "http_403",
  "http_5xx",
  "timeout",
  "connection_refused",
  "ssl_error",
  "dns_error",
  "parse_error",
  "download_failed",
  "captcha_blocked",
  "too_large",
  "unsupported_format",
  "unknown",
] as const;

export type FailureType = typeof FAILURE_TYPES[number];

export const FAILURE_LABELS: Record<FailureType, string> = {
  http_404: "Not Found (404)",
  http_403: "Forbidden (403)",
  http_5xx: "Server Error (5xx)",
  timeout: "Timeout",
  connection_refused: "Connection Refused",
  ssl_error: "SSL/TLS Error",
  dns_error: "DNS Resolution Failed",
  parse_error: "Parse Error",
  download_failed: "Download Failed",
  captcha_blocked: "CAPTCHA/Bot Blocked",
  too_large: "File Too Large",
  unsupported_format: "Unsupported Format",
  unknown: "Unknown Error",
};

export function classifyError(error: string | Error | unknown): FailureType {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (msg.includes("404") || msg.includes("not found")) return "http_404";
  if (msg.includes("403") || msg.includes("forbidden")) return "http_403";
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("server error") || msg.includes("internal error")) return "http_5xx";
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout") || msg.includes("navigation timeout")) return "timeout";
  if (msg.includes("econnrefused") || msg.includes("connection refused")) return "connection_refused";
  if (msg.includes("ssl") || msg.includes("tls") || msg.includes("cert") || msg.includes("certificate")) return "ssl_error";
  if (msg.includes("enotfound") || msg.includes("dns") || msg.includes("getaddrinfo")) return "dns_error";
  if (msg.includes("parse") || msg.includes("syntax") || msg.includes("unexpected token") || msg.includes("invalid json")) return "parse_error";
  if (msg.includes("download") || msg.includes("fetch") || msg.includes("econnreset") || msg.includes("socket hang up")) return "download_failed";
  if (msg.includes("captcha") || msg.includes("bot") || msg.includes("challenge") || msg.includes("cloudflare")) return "captcha_blocked";
  if (msg.includes("too large") || msg.includes("content-length") || msg.includes("payload too large")) return "too_large";
  if (msg.includes("unsupported") || msg.includes("format")) return "unsupported_format";

  return "unknown";
}

export interface CrawlRunSummary {
  byCategory: Record<string, number>;
  byBoard: Record<string, number>;
  newDocuments: number;
  duplicates: number;
  errors: Array<{ url: string; error: string; failureType?: FailureType }>;
  failuresByType?: Record<FailureType, number>;
  pagesVisited?: number;
  documentsDiscovered?: number;
  averageDocsPerPage?: number;
  protectionStats?: {
    detected: boolean;
    types: string[];
    blockedPages: number;
    blockedDocuments: number;
  };
}

// ============================================================
// STATE SOURCE TABLES
// ============================================================

export const STATE_DOC_CATEGORIES = [
  "rsas",
  "session_laws",
  "administrative_rules",
  "regulations",
  "guidance",
  "budgetary",
  "model_documents",
  "forms",
  "bulletins",
  "manuals",
  "opinions",
  "other",
] as const;

export type StateDocCategory = typeof STATE_DOC_CATEGORIES[number];

export const STATE_DOC_CATEGORY_LABELS: Record<StateDocCategory, string> = {
  rsas: "Revised Statutes Annotated (RSAs)",
  session_laws: "Session Laws",
  administrative_rules: "Administrative Rules",
  regulations: "Regulations",
  guidance: "Guidance Documents",
  budgetary: "Budgetary & Financial",
  model_documents: "Model Documents & Templates",
  forms: "Forms & Applications",
  bulletins: "Bulletins & Notices",
  manuals: "Manuals & Handbooks",
  opinions: "Opinions & Advisories",
  other: "Other Documents",
};

export const UPDATE_CADENCES = [
  "annual",
  "semi_annual",
  "quarterly",
  "monthly",
  "weekly",
  "as_needed",
] as const;

export type UpdateCadence = typeof UPDATE_CADENCES[number];

export const crawlerStateSources = pgTable("crawler_state_sources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  agency: text("agency").notNull(),
  agencyAbbrev: text("agency_abbrev"),
  state: text("state").notNull().default("NH"),
  baseUrl: text("base_url").notNull(),
  description: text("description"),

  docCategories: jsonb("doc_categories").notNull().$type<StateDocCategory[]>().default([]),
  targetPaths: jsonb("target_paths").notNull().$type<string[]>().default([]),
  linkPatterns: jsonb("link_patterns").notNull().$type<string[]>().default([]),
  excludePatterns: jsonb("exclude_patterns").notNull().$type<string[]>().default([]),

  updateCadence: text("update_cadence").notNull().default("quarterly"),
  maxPages: integer("max_pages"),
  scope: text("scope").notNull().default("statewide"),

  status: text("status").notNull().default("active"),
  lastCrawlDate: timestamp("last_crawl_date"),
  nextScheduledCrawl: timestamp("next_scheduled_crawl"),
  totalDocuments: integer("total_documents").notNull().default(0),
  totalUploaded: integer("total_uploaded").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),

  notes: text("notes"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const crawlerStateSourceRuns = pgTable("crawler_state_source_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceId: varchar("source_id").notNull().references(() => crawlerStateSources.id, { onDelete: "cascade" }),

  mode: text("mode").notNull(),
  triggerType: text("trigger_type").notNull(),

  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("running"),

  pagesVisited: integer("pages_visited").notNull().default(0),
  documentsDiscovered: integer("documents_discovered").notNull().default(0),
  documentsDownloaded: integer("documents_downloaded").notNull().default(0),
  documentsUploaded: integer("documents_uploaded").notNull().default(0),
  documentsFailed: integer("documents_failed").notNull().default(0),

  maxPagesLimit: integer("max_pages_limit"),
  errorMessage: text("error_message"),
  summary: jsonb("summary"),
});

export const crawlerStateDocuments = pgTable("crawler_state_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceId: varchar("source_id").notNull().references(() => crawlerStateSources.id, { onDelete: "cascade" }),

  url: text("url").notNull(),
  urlHash: text("url_hash").notNull().unique(),
  filename: text("filename").notNull(),

  category: text("category"),
  subcategory: text("subcategory"),
  title: text("title"),
  rsaChapter: text("rsa_chapter"),

  sizeBytes: integer("size_bytes"),
  mimeType: text("mime_type"),

  s3Key: text("s3_key"),
  s3UploadedAt: timestamp("s3_uploaded_at"),

  discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
  discoveredFrom: text("discovered_from"),
  status: text("status").notNull().default("discovered"),
  errorMessage: text("error_message"),

  fileBlobId: varchar("file_blob_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Insert schemas
export const insertCrawlerTownSchema = createInsertSchema(crawlerTowns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCrawlerSitemapSchema = createInsertSchema(crawlerSitemaps).omit({
  id: true,
  discoveredAt: true,
  lastChecked: true,
});

export const insertCrawlerUrlSchema = createInsertSchema(crawlerUrls).omit({
  id: true,
  firstDiscovered: true,
});

export const insertCrawlerDocumentSchema = createInsertSchema(crawlerDocuments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  discoveredAt: true,
});

export const insertCrawlerRunSchema = createInsertSchema(crawlerRuns).omit({
  id: true,
  startedAt: true,
});

export const insertCrawlAssessmentSchema = createInsertSchema(crawlAssessments).omit({
  id: true,
  createdAt: true,
});

export const insertStateSourceSchema = createInsertSchema(crawlerStateSources).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertStateSourceRunSchema = createInsertSchema(crawlerStateSourceRuns).omit({
  id: true,
  startedAt: true,
});

export const insertStateDocumentSchema = createInsertSchema(crawlerStateDocuments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  discoveredAt: true,
});

// Types
export type CrawlAssessment = typeof crawlAssessments.$inferSelect;
export type InsertCrawlAssessment = z.infer<typeof insertCrawlAssessmentSchema>;

export type CrawlerTown = typeof crawlerTowns.$inferSelect;
export type InsertCrawlerTown = z.infer<typeof insertCrawlerTownSchema>;

export type CrawlerSitemap = typeof crawlerSitemaps.$inferSelect;
export type InsertCrawlerSitemap = z.infer<typeof insertCrawlerSitemapSchema>;

export type CrawlerUrl = typeof crawlerUrls.$inferSelect;
export type InsertCrawlerUrl = z.infer<typeof insertCrawlerUrlSchema>;

export type CrawlerDocument = typeof crawlerDocuments.$inferSelect;
export type InsertCrawlerDocument = z.infer<typeof insertCrawlerDocumentSchema>;

export type CrawlerRun = typeof crawlerRuns.$inferSelect;
export type InsertCrawlerRun = z.infer<typeof insertCrawlerRunSchema>;

export type CrawlerStateSource = typeof crawlerStateSources.$inferSelect;
export type InsertCrawlerStateSource = z.infer<typeof insertStateSourceSchema>;

export type CrawlerStateSourceRun = typeof crawlerStateSourceRuns.$inferSelect;
export type InsertCrawlerStateSourceRun = z.infer<typeof insertStateSourceRunSchema>;

export type CrawlerStateDocument = typeof crawlerStateDocuments.$inferSelect;
export type InsertCrawlerStateDocument = z.infer<typeof insertStateDocumentSchema>;

// Status types
export type TownStatus = "active" | "failed" | "paused" | "disabled";
export type DocumentStatus = "discovered" | "downloaded" | "uploaded" | "failed";
export type RunStatus = "running" | "completed" | "failed" | "timeout";
export type CrawlMode = "full" | "incremental" | "manual";
export type TriggerType = "scheduled" | "manual" | "retry" | "bot";
export type UrlSource = "sitemap" | "navigation" | "custom" | "deep_link";
export type Priority = "high" | "medium" | "low";
