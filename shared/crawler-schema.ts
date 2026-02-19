import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
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
  logPath: text("log_path"), // Path to detailed log file
});

// ============================================================
// TYPES & SCHEMAS
// ============================================================

export interface SitemapUrl {
  url: string;
  priority: "high" | "medium" | "low";
  discovered: string; // ISO timestamp
  lastVisited?: string; // ISO timestamp
  docCount: number;
}

export interface CrawlRunSummary {
  byCategory: Record<string, number>;
  byBoard: Record<string, number>;
  newDocuments: number;
  duplicates: number;
  errors: Array<{ url: string; error: string }>;
}

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

// Types
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

// Status types
export type TownStatus = "active" | "failed" | "paused" | "disabled";
export type DocumentStatus = "discovered" | "downloaded" | "uploaded" | "failed";
export type RunStatus = "running" | "completed" | "failed" | "timeout";
export type CrawlMode = "full" | "incremental" | "manual";
export type TriggerType = "scheduled" | "manual" | "retry";
export type UrlSource = "sitemap" | "navigation" | "custom" | "deep_link";
export type Priority = "high" | "medium" | "low";
