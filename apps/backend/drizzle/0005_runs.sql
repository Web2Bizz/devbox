CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_leases" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text,
	"status" text DEFAULT 'open' NOT NULL,
	"definition_set_hash" text NOT NULL,
	"base_commit" text NOT NULL,
	"branch" text NOT NULL,
	"worktree" text NOT NULL,
	"sandbox_id" text,
	"agent_id" text,
	"model" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"input_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"observed_epoch" integer DEFAULT 0 NOT NULL,
	"result_ref" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "run_steps_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_run_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_leases" ADD CONSTRAINT "run_leases_run_id_run_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_runs" ADD CONSTRAINT "run_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_run_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "run_runs_project_idx" ON "run_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "run_runs_project_status_idx" ON "run_runs" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_seq_idx" ON "run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "run_steps_run_status_idx" ON "run_steps" USING btree ("run_id","status");