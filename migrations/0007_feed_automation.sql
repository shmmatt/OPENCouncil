-- Feed Automation: Task #19
-- Adds feed_type, header_image_url, and automation_source_version_id columns to town_feed_items

ALTER TABLE "town_feed_items"
  ADD COLUMN IF NOT EXISTS "feed_type" text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "header_image_url" text,
  ADD COLUMN IF NOT EXISTS "automation_source_version_id" varchar;
