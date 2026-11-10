CREATE TABLE "vault_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consumer_type" text NOT NULL,
	"consumer_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"encrypted_key" text NOT NULL,
	"iv" text NOT NULL,
	"key_id" text DEFAULT 'v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_secrets_consumer_type_check" CHECK ("vault_secrets"."consumer_type" in ('user', 'org'))
);
--> statement-breakpoint
CREATE INDEX "vault_secrets_consumer_provider_idx" ON "vault_secrets" USING btree ("consumer_type","consumer_id","provider");--> statement-breakpoint
INSERT INTO "vault_secrets" ("consumer_type","consumer_id","provider","label","encrypted_key","iv","key_id","created_at","updated_at")
	SELECT 'user', "user_id", "provider", 'default', "encrypted_key", "iv", "key_id", "updated_at", "updated_at" FROM "user_opencode_keys";--> statement-breakpoint
DROP TABLE "user_opencode_keys";