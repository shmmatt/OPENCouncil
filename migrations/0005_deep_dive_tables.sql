CREATE TABLE IF NOT EXISTS "deep_dive_sessions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "chat_session_id" varchar NOT NULL REFERENCES "chat_sessions"("id") ON DELETE CASCADE,
  "message_id" varchar NOT NULL,
  "question" text NOT NULL,
  "town" text,
  "status" text NOT NULL DEFAULT 'running',
  "final_answer" text,
  "quality_score" integer,
  "completeness_score" integer,
  "iteration_count" integer NOT NULL DEFAULT 0,
  "total_cost_usd" numeric(10, 6),
  "total_duration_ms" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

CREATE TABLE IF NOT EXISTS "deep_dive_steps" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "deep_dive_id" varchar NOT NULL REFERENCES "deep_dive_sessions"("id") ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS "idx_deep_dive_sessions_chat_session" ON "deep_dive_sessions"("chat_session_id");
CREATE INDEX IF NOT EXISTS "idx_deep_dive_sessions_status" ON "deep_dive_sessions"("status");
CREATE INDEX IF NOT EXISTS "idx_deep_dive_sessions_created" ON "deep_dive_sessions"("created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_deep_dive_steps_deep_dive" ON "deep_dive_steps"("deep_dive_id");
