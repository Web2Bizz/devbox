--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_invites" (
  "token" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "email" text,
  "role" text NOT NULL DEFAULT 'user' CHECK ("role" IN ('maintainer', 'user')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_invites_org_idx" ON "organization_invites" ("org_id");
