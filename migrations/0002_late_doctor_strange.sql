CREATE TABLE "chat_review_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_ids" jsonb NOT NULL,
	"total_sessions" integer NOT NULL,
	"successful_analyses" integer DEFAULT 0 NOT NULL,
	"avg_doc_score" numeric,
	"avg_answer_score" numeric,
	"thumbs_up_count" integer DEFAULT 0,
	"thumbs_down_count" integer DEFAULT 0,
	"top_missing_docs" text,
	"executive_summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deep_dive_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_session_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"question" text NOT NULL,
	"town" text,
	"status" text DEFAULT 'running' NOT NULL,
	"final_answer" text,
	"quality_score" integer,
	"completeness_score" integer,
	"iteration_count" integer DEFAULT 0 NOT NULL,
	"total_cost_usd" numeric(10, 6),
	"total_duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "deep_dive_steps" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deep_dive_id" varchar NOT NULL,
	"step_number" integer NOT NULL,
	"step_type" text NOT NULL,
	"input" text NOT NULL,
	"output" text NOT NULL,
	"reasoning" text,
	"tool_used" text,
	"model_used" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(10, 6),
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_gaps" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"town" text,
	"description" text NOT NULL,
	"user_query" text NOT NULL,
	"session_id" varchar,
	"message_id" varchar,
	"detection_source" text NOT NULL,
	"record_strength_tier" text,
	"status" text DEFAULT 'open' NOT NULL,
	"hit_count" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp,
	"admin_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missing_doc_suggestions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed_item_id" varchar,
	"template_id" varchar,
	"status" text DEFAULT 'draft' NOT NULL,
	"content_matrix" jsonb,
	"deep_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"media_assets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_reports" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"town_name" text NOT NULL,
	"report_type" text DEFAULT 'friction' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"report_data" jsonb,
	"error" text,
	"chunks_analyzed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"board_type" text,
	"date_range_start" text,
	"date_range_end" text,
	"prompt" text,
	"document_count" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "town_feed_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"town" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routine_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_minutes_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"news_articles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"generated_payload" jsonb,
	"template_id" varchar,
	"published_at" timestamp,
	"upvote_count" integer DEFAULT 0 NOT NULL,
	"topic_emoji" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_keywords" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"keyword" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_upvotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"feed_item_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_upvotes_user_feed_unique" UNIQUE("user_id","feed_item_id")
);
--> statement-breakpoint
CREATE TABLE "crawler_sau_documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" varchar NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"filename" text NOT NULL,
	"category" text,
	"title" text,
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
	CONSTRAINT "crawler_sau_documents_url_hash_unique" UNIQUE("url_hash")
);
--> statement-breakpoint
CREATE TABLE "crawler_sau_source_runs" (
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
CREATE TABLE "crawler_sau_sources" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sau_id" text NOT NULL,
	"base_url" text NOT NULL,
	"description" text,
	"member_towns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"county" text,
	"state" text DEFAULT 'NH' NOT NULL,
	"target_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclude_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_pages" integer,
	"scope" text DEFAULT 'sau' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_crawl_date" timestamp,
	"next_scheduled_crawl" timestamp,
	"total_documents" integer DEFAULT 0 NOT NULL,
	"total_uploaded" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crawler_sau_sources_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "gap_category" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "pipeline_stage" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "critical_domain_error" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "user_intent" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "prompting_suggestions" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "pipeline_suggestions" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "feedback" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "feed_item_id" varchar;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "document_version_id" varchar;--> statement-breakpoint
ALTER TABLE "chat_templates" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "chat_templates" ADD COLUMN "linked_feed_item_id" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_towns" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_subscription_status" text;--> statement-breakpoint
ALTER TABLE "crawler_state_sources" ADD COLUMN "crawl_method" text DEFAULT 'crawl' NOT NULL;--> statement-breakpoint
ALTER TABLE "deep_dive_sessions" ADD CONSTRAINT "deep_dive_sessions_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_steps" ADD CONSTRAINT "deep_dive_steps_deep_dive_id_deep_dive_sessions_id_fk" FOREIGN KEY ("deep_dive_id") REFERENCES "public"."deep_dive_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_gaps" ADD CONSTRAINT "document_gaps_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_requests" ADD CONSTRAINT "feature_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_doc_suggestions" ADD CONSTRAINT "missing_doc_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_feed_item_id_town_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."town_feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_template_id_chat_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."chat_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keywords" ADD CONSTRAINT "user_keywords_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_upvotes" ADD CONSTRAINT "user_upvotes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_upvotes" ADD CONSTRAINT "user_upvotes_feed_item_id_town_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."town_feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawler_sau_documents" ADD CONSTRAINT "crawler_sau_documents_source_id_crawler_sau_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."crawler_sau_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawler_sau_source_runs" ADD CONSTRAINT "crawler_sau_source_runs_source_id_crawler_sau_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."crawler_sau_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_templates" ADD CONSTRAINT "chat_templates_slug_unique" UNIQUE("slug");