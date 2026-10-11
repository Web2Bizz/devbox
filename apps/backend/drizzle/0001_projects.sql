--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "description" text,
  "github_owner" text,
  "github_repo" text,
  "github_branch" text DEFAULT 'main',
  "github_url" text,
  "owner_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_chats" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_chats_project_idx" ON "project_chats" ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "chat_id" uuid REFERENCES "project_chats"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'open',
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_sessions_project_idx" ON "project_sessions" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_sessions_chat_idx" ON "project_sessions" ("chat_id");
