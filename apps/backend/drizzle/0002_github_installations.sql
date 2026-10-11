--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text,
  "installation_id" bigint NOT NULL UNIQUE,
  "account_login" text,
  "account_type" text,
  "suspended_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_installations_user_idx" ON "github_installations" ("user_id");
