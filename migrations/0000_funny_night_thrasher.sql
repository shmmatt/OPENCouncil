CREATE TABLE "admins" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "anonymous_users" (
	"id" varchar PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"user_id" varchar,
	"default_town" text
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"user_id" varchar,
	"anon_id" varchar,
	"town_preference" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar NOT NULL,
	"file_blob_id" varchar NOT NULL,
	"year" text,
	"notes" text,
	"file_search_store_name" text,
	"file_search_document_name" text,
	"is_current" boolean DEFAULT false NOT NULL,
	"supersedes_version_id" varchar,
	"meeting_date" timestamp,
	"is_minutes" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"original_name" text NOT NULL,
	"file_search_file_id" text,
	"file_search_store_id" text,
	"category" text,
	"town" text,
	"board" text,
	"year" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"user_id" varchar,
	"anon_id" varchar,
	"event_type" text NOT NULL,
	"session_id" varchar,
	"town" text,
	"board" text,
	"topic" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_blobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_hash" text NOT NULL,
	"preview_hash" text,
	"size_bytes" integer NOT NULL,
	"mime_type" text NOT NULL,
	"original_filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"preview_text" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_blob_id" varchar NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"suggested_metadata" jsonb,
	"final_metadata" jsonb,
	"metadata_hints" jsonb,
	"duplicate_warning" text,
	"status_note" text,
	"document_id" varchar,
	"document_version_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_cost_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"user_id" varchar,
	"anon_id" varchar,
	"session_id" varchar,
	"request_id" text,
	"stage" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logical_documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_title" text NOT NULL,
	"town" text NOT NULL,
	"board" text,
	"category" text NOT NULL,
	"current_version_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temp_uploads" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"original_name" text NOT NULL,
	"file_path" text NOT NULL,
	"preview_text" text,
	"suggested_category" text,
	"suggested_town" text,
	"suggested_board" text,
	"suggested_year" text,
	"suggested_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"provider" text NOT NULL,
	"provider_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_provider_key_unique" UNIQUE("provider","provider_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"default_town" text,
	"is_paying" boolean DEFAULT false NOT NULL,
	"is_municipal_staff" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "anonymous_users" ADD CONSTRAINT "anonymous_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_anon_id_anonymous_users_id_fk" FOREIGN KEY ("anon_id") REFERENCES "public"."anonymous_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_logical_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."logical_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_file_blob_id_file_blobs_id_fk" FOREIGN KEY ("file_blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_anon_id_anonymous_users_id_fk" FOREIGN KEY ("anon_id") REFERENCES "public"."anonymous_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_file_blob_id_file_blobs_id_fk" FOREIGN KEY ("file_blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_cost_logs" ADD CONSTRAINT "llm_cost_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_cost_logs" ADD CONSTRAINT "llm_cost_logs_anon_id_anonymous_users_id_fk" FOREIGN KEY ("anon_id") REFERENCES "public"."anonymous_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_cost_logs" ADD CONSTRAINT "llm_cost_logs_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;