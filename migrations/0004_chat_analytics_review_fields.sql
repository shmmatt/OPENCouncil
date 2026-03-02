ALTER TABLE chat_analytics ADD COLUMN IF NOT EXISTS gap_category TEXT;
ALTER TABLE chat_analytics ADD COLUMN IF NOT EXISTS pipeline_stage TEXT;
ALTER TABLE chat_analytics ADD COLUMN IF NOT EXISTS critical_domain_error BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chat_analytics ADD COLUMN IF NOT EXISTS user_intent TEXT;
ALTER TABLE chat_analytics ADD COLUMN IF NOT EXISTS prompting_suggestions TEXT;
ALTER TABLE chat_analytics ADD COLUMN IF NOT EXISTS pipeline_suggestions TEXT;
