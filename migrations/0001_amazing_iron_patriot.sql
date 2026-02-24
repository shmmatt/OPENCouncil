CREATE TABLE "chat_analytics" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar NOT NULL,
	"summary" text NOT NULL,
	"critique" text NOT NULL,
	"missing_docs_suggestions" text,
	"document_quality_score" integer,
	"answer_quality_score" integer,
	"analyzed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_analytics_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "chat_templates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"banner_text" text NOT NULL,
	"town" text NOT NULL,
	"target_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_payload" jsonb,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" varchar,
	"file_blob_id" varchar,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "embedding_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" varchar,
	"file_blob_id" varchar,
	"batch_id" varchar,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"error" text,
	"chunks_count" integer,
	"file_blobs_processed" integer,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ocr_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" varchar NOT NULL,
	"file_blob_id" varchar,
	"status" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"page_count" integer,
	"native_text_chars" integer,
	"is_pdf" boolean,
	"textract_job_id" text,
	"textract_started_at" timestamp,
	"textract_completed_at" timestamp,
	"textract_next_token" text,
	"s3_bucket" text,
	"s3_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "s3_gemini_sync" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"s3_key" text NOT NULL,
	"gemini_store_id" text NOT NULL,
	"gemini_document_id" text,
	"town" text NOT NULL,
	"category" text,
	"board" text,
	"year" text,
	"size_bytes" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "s3_gemini_sync_s3_key_unique" UNIQUE("s3_key")
);
--> statement-breakpoint
CREATE TABLE "crawl_assessments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"town_id" varchar NOT NULL,
	"assessed_at" timestamp DEFAULT now() NOT NULL,
	"population" integer,
	"predicted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estimated" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"category_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"overall_score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"total_files_analyzed" integer DEFAULT 0 NOT NULL,
	"llm_model" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawler_documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"town_id" varchar NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"filename" text NOT NULL,
	"category" text,
	"board" text,
	"year" text,
	"size_bytes" integer,
	"mime_type" text,
	"s3_key" text,
	"s3_uploaded_at" timestamp,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	"discovered_from" text,
	"status" text DEFAULT 'discovered' NOT NULL,
	"error_message" text,
	"content_validated" boolean DEFAULT false NOT NULL,
	"last_verified" timestamp,
	"s3_sync_id" varchar,
	"file_blob_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crawler_documents_url_hash_unique" UNIQUE("url_hash")
);
--> statement-breakpoint
CREATE TABLE "crawler_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"town_id" varchar NOT NULL,
	"mode" text NOT NULL,
	"trigger_type" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"status" text DEFAULT 'running' NOT NULL,
	"pages_visited" integer DEFAULT 0 NOT NULL,
	"documents_discovered" integer DEFAULT 0 NOT NULL,
	"documents_downloaded" integer DEFAULT 0 NOT NULL,
	"documents_uploaded" integer DEFAULT 0 NOT NULL,
	"documents_failed" integer DEFAULT 0 NOT NULL,
	"max_pages_limit" integer,
	"resumed_from_checkpoint" boolean DEFAULT false NOT NULL,
	"error_message" text,
	"summary" jsonb,
	"log_path" text,
	"logs" jsonb
);
--> statement-breakpoint
CREATE TABLE "crawler_sitemaps" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"town_id" varchar NOT NULL,
	"sitemap_url" text NOT NULL,
	"hash" text NOT NULL,
	"url_count" integer DEFAULT 0 NOT NULL,
	"urls" jsonb NOT NULL,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	"last_checked" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawler_state_documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" varchar NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"filename" text NOT NULL,
	"category" text,
	"subcategory" text,
	"title" text,
	"rsa_chapter" text,
	"size_bytes" integer,
	"mime_type" text,
	"s3_key" text,
	"s3_uploaded_at" timestamp,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	"discovered_from" text,
	"status" text DEFAULT 'discovered' NOT NULL,
	"error_message" text,
	"file_blob_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crawler_state_documents_url_hash_unique" UNIQUE("url_hash")
);
--> statement-breakpoint
CREATE TABLE "crawler_state_source_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" varchar NOT NULL,
	"mode" text NOT NULL,
	"trigger_type" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"status" text DEFAULT 'running' NOT NULL,
	"pages_visited" integer DEFAULT 0 NOT NULL,
	"documents_discovered" integer DEFAULT 0 NOT NULL,
	"documents_downloaded" integer DEFAULT 0 NOT NULL,
	"documents_uploaded" integer DEFAULT 0 NOT NULL,
	"documents_failed" integer DEFAULT 0 NOT NULL,
	"max_pages_limit" integer,
	"error_message" text,
	"summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "crawler_state_sources" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"agency" text NOT NULL,
	"agency_abbrev" text,
	"state" text DEFAULT 'NH' NOT NULL,
	"base_url" text NOT NULL,
	"description" text,
	"doc_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclude_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"update_cadence" text DEFAULT 'quarterly' NOT NULL,
	"max_pages" integer,
	"scope" text DEFAULT 'statewide' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_crawl_date" timestamp,
	"next_scheduled_crawl" timestamp,
	"total_documents" integer DEFAULT 0 NOT NULL,
	"total_uploaded" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crawler_state_sources_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "crawler_towns" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"cms" text,
	"county" text,
	"state" text DEFAULT 'NH' NOT NULL,
	"population" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"last_full_crawl" timestamp,
	"last_incremental_crawl" timestamp,
	"next_scheduled_crawl" timestamp,
	"total_documents" integer DEFAULT 0 NOT NULL,
	"total_uploaded" integer DEFAULT 0 NOT NULL,
	"last_crawl_docs_found" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"max_pages" integer,
	"custom_paths" jsonb,
	"drive_folder_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crawler_towns_name_unique" UNIQUE("name"),
	CONSTRAINT "crawler_towns_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "crawler_urls" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"town_id" varchar NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"source" text NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"first_discovered" timestamp DEFAULT now() NOT NULL,
	"last_visited" timestamp,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"document_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "attachment_filename" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "attachment_mime_type" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "attachment_extracted_text" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "template_id" varchar;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "situation_context" jsonb;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "session_sources" jsonb;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "s3_bucket" text;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "s3_key" text;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "file_sha256" text;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "extracted_text_char_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "needs_ocr" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "ocr_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "ocr_provider" text;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "ocr_failure_reason" text;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "ocr_text" text;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "ocr_text_char_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "ocr_queued_at" timestamp;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "ocr_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "ocr_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "ocr_reindexed_at" timestamp;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "extracted_text_s3_key" text;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "extracted_text_sha256" text;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "embedding_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "chunk_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD COLUMN "embedded_at" timestamp;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD CONSTRAINT "chat_analytics_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_file_blob_id_file_blobs_id_fk" FOREIGN KEY ("file_blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_assessments" ADD CONSTRAINT "crawl_assessments_town_id_crawler_towns_id_fk" FOREIGN KEY ("town_id") REFERENCES "public"."crawler_towns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawler_documents" ADD CONSTRAINT "crawler_documents_town_id_crawler_towns_id_fk" FOREIGN KEY ("town_id") REFERENCES "public"."crawler_towns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawler_runs" ADD CONSTRAINT "crawler_runs_town_id_crawler_towns_id_fk" FOREIGN KEY ("town_id") REFERENCES "public"."crawler_towns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawler_sitemaps" ADD CONSTRAINT "crawler_sitemaps_town_id_crawler_towns_id_fk" FOREIGN KEY ("town_id") REFERENCES "public"."crawler_towns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawler_state_documents" ADD CONSTRAINT "crawler_state_documents_source_id_crawler_state_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."crawler_state_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawler_state_source_runs" ADD CONSTRAINT "crawler_state_source_runs_source_id_crawler_state_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."crawler_state_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawler_urls" ADD CONSTRAINT "crawler_urls_town_id_crawler_towns_id_fk" FOREIGN KEY ("town_id") REFERENCES "public"."crawler_towns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_template_id_chat_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."chat_templates"("id") ON DELETE no action ON UPDATE no action;