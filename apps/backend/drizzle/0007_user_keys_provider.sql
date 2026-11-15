ALTER TABLE "user_opencode_keys" ADD COLUMN "provider" text DEFAULT 'opencode' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_opencode_keys" DROP CONSTRAINT "user_opencode_keys_pkey";--> statement-breakpoint
ALTER TABLE "user_opencode_keys" ADD CONSTRAINT "user_opencode_keys_user_id_provider_pk" PRIMARY KEY("user_id","provider");
