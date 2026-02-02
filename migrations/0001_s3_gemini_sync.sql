-- S3 to Gemini File Search Sync Table
-- Tracks files synced from S3 to Gemini stores to avoid re-uploading

CREATE TABLE IF NOT EXISTS "s3_gemini_sync" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "s3_key" text NOT NULL UNIQUE,
  "gemini_store_id" text NOT NULL,
  "gemini_document_id" text,
  "town" text NOT NULL,
  "category" text,
  "board" text,
  "year" text,
  "size_bytes" integer,
  "status" text NOT NULL DEFAULT 'pending',
  "error_message" text,
  "synced_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Index for fast lookups by town and status
CREATE INDEX IF NOT EXISTS "s3_gemini_sync_town_idx" ON "s3_gemini_sync" ("town");
CREATE INDEX IF NOT EXISTS "s3_gemini_sync_status_idx" ON "s3_gemini_sync" ("status");
CREATE INDEX IF NOT EXISTS "s3_gemini_sync_town_status_idx" ON "s3_gemini_sync" ("town", "status");
