-- Migration: Add User Dashboard Tables
-- Date: 2026-03-19
-- Description: Adds tables for user interest dashboard: keywords, feature requests, missing doc suggestions

-- User Keywords: Keywords a user wants to watch for in documents
CREATE TABLE IF NOT EXISTS "user_keywords" (
  "id" VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" VARCHAR NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "keyword" TEXT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Feature Requests: User-submitted feature requests
CREATE TABLE IF NOT EXISTS "feature_requests" (
  "id" VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" VARCHAR NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "text" TEXT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Missing Doc Suggestions: User-submitted suggestions for missing documents
CREATE TABLE IF NOT EXISTS "missing_doc_suggestions" (
  "id" VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" VARCHAR NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "text" TEXT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);
