--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_opencode_keys" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "encrypted_key" text NOT NULL,
  "iv" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
