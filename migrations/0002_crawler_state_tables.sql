-- Migration: Add Crawler State Management Tables
-- Date: 2026-02-12
-- Description: Adds tables for tracking crawler state, sitemaps, discovered documents, and run history

-- ============================================================
-- Crawler Towns: Master registry
-- ============================================================
CREATE TABLE IF NOT EXISTS "crawler_towns" (
  "id" VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL UNIQUE,
  "slug" TEXT NOT NULL UNIQUE,
  "url" TEXT NOT NULL,
  "cms" TEXT,
  "county" TEXT,
  "state" TEXT NOT NULL DEFAULT 'NH',
  
  -- Crawl status
  "status" TEXT NOT NULL DEFAULT 'active',
  "last_full_crawl" TIMESTAMP,
  "last_incremental_crawl" TIMESTAMP,
  "next_scheduled_crawl" TIMESTAMP,
  
  -- Stats
  "total_documents" INTEGER NOT NULL DEFAULT 0,
  "total_uploaded" INTEGER NOT NULL DEFAULT 0,
  "last_crawl_docs_found" INTEGER NOT NULL DEFAULT 0,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  
  -- Config overrides
  "max_pages" INTEGER,
  "custom_paths" JSONB,
  
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Index for lookups
CREATE INDEX IF NOT EXISTS "idx_crawler_towns_slug" ON "crawler_towns"("slug");
CREATE INDEX IF NOT EXISTS "idx_crawler_towns_status" ON "crawler_towns"("status");

-- ============================================================
-- Crawler Sitemaps: Sitemap snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS "crawler_sitemaps" (
  "id" VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  "town_id" VARCHAR NOT NULL REFERENCES "crawler_towns"("id") ON DELETE CASCADE,
  
  "sitemap_url" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "url_count" INTEGER NOT NULL DEFAULT 0,
  "urls" JSONB NOT NULL,
  
  "discovered_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "last_checked" TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Index for town lookups and hash comparison
CREATE INDEX IF NOT EXISTS "idx_crawler_sitemaps_town" ON "crawler_sitemaps"("town_id");
CREATE INDEX IF NOT EXISTS "idx_crawler_sitemaps_hash" ON "crawler_sitemaps"("hash");

-- ============================================================
-- Crawler URLs: Individual URL tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS "crawler_urls" (
  "id" VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  "town_id" VARCHAR NOT NULL REFERENCES "crawler_towns"("id") ON DELETE CASCADE,
  
  "url" TEXT NOT NULL,
  "url_hash" TEXT NOT NULL,
  
  "source" TEXT NOT NULL,
  "priority" TEXT NOT NULL DEFAULT 'medium',
  
  "first_discovered" TIMESTAMP DEFAULT NOW() NOT NULL,
  "last_visited" TIMESTAMP,
  "visit_count" INTEGER NOT NULL DEFAULT 0,
  "document_count" INTEGER NOT NULL DEFAULT 0,
  
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error_message" TEXT
);

-- Indexes for deduplication and lookups
CREATE UNIQUE INDEX IF NOT EXISTS "idx_crawler_urls_town_hash" ON "crawler_urls"("town_id", "url_hash");
CREATE INDEX IF NOT EXISTS "idx_crawler_urls_status" ON "crawler_urls"("status");
CREATE INDEX IF NOT EXISTS "idx_crawler_urls_priority" ON "crawler_urls"("priority");

-- ============================================================
-- Crawler Documents: Document discovery registry
-- ============================================================
CREATE TABLE IF NOT EXISTS "crawler_documents" (
  "id" VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  "town_id" VARCHAR NOT NULL REFERENCES "crawler_towns"("id") ON DELETE CASCADE,
  
  "url" TEXT NOT NULL,
  "url_hash" TEXT NOT NULL UNIQUE,
  "filename" TEXT NOT NULL,
  
  "category" TEXT,
  "board" TEXT,
  "year" TEXT,
  
  "size_bytes" INTEGER,
  "mime_type" TEXT,
  
  "s3_key" TEXT,
  "s3_uploaded_at" TIMESTAMP,
  
  "discovered_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "discovered_from" TEXT,
  "status" TEXT NOT NULL DEFAULT 'discovered',
  "error_message" TEXT,
  
  "content_validated" BOOLEAN NOT NULL DEFAULT FALSE,
  "last_verified" TIMESTAMP,
  
  "s3_sync_id" VARCHAR,
  
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Indexes for lookups and deduplication
CREATE INDEX IF NOT EXISTS "idx_crawler_documents_town" ON "crawler_documents"("town_id");
CREATE INDEX IF NOT EXISTS "idx_crawler_documents_status" ON "crawler_documents"("status");
CREATE INDEX IF NOT EXISTS "idx_crawler_documents_s3_key" ON "crawler_documents"("s3_key");
CREATE INDEX IF NOT EXISTS "idx_crawler_documents_discovered" ON "crawler_documents"("discovered_at" DESC);

-- ============================================================
-- Crawler Runs: Execution history
-- ============================================================
CREATE TABLE IF NOT EXISTS "crawler_runs" (
  "id" VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  "town_id" VARCHAR NOT NULL REFERENCES "crawler_towns"("id") ON DELETE CASCADE,
  
  "mode" TEXT NOT NULL,
  "trigger_type" TEXT NOT NULL,
  
  "started_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "completed_at" TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'running',
  
  "pages_visited" INTEGER NOT NULL DEFAULT 0,
  "documents_discovered" INTEGER NOT NULL DEFAULT 0,
  "documents_downloaded" INTEGER NOT NULL DEFAULT 0,
  "documents_uploaded" INTEGER NOT NULL DEFAULT 0,
  "documents_failed" INTEGER NOT NULL DEFAULT 0,
  
  "max_pages_limit" INTEGER,
  "resumed_from_checkpoint" BOOLEAN NOT NULL DEFAULT FALSE,
  
  "error_message" TEXT,
  "summary" JSONB,
  "log_path" TEXT
);

-- Indexes for history queries
CREATE INDEX IF NOT EXISTS "idx_crawler_runs_town" ON "crawler_runs"("town_id");
CREATE INDEX IF NOT EXISTS "idx_crawler_runs_started" ON "crawler_runs"("started_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_crawler_runs_status" ON "crawler_runs"("status");

-- ============================================================
-- Comments for documentation
-- ============================================================
COMMENT ON TABLE "crawler_towns" IS 'Master registry of all towns being crawled with metadata and status';
COMMENT ON TABLE "crawler_sitemaps" IS 'Sitemap snapshots for diffing and incremental crawl optimization';
COMMENT ON TABLE "crawler_urls" IS 'Individual URL tracking for visit history and prioritization';
COMMENT ON TABLE "crawler_documents" IS 'Registry of all discovered documents with upload and sync tracking';
COMMENT ON TABLE "crawler_runs" IS 'Historical record of each crawl execution for analytics and debugging';
