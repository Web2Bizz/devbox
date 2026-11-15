CREATE TABLE "agent_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"thread_id" text,
	"segment_index" integer NOT NULL,
	"steps_used" integer NOT NULL,
	"total_steps" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"pause_reason" text,
	"state" jsonb,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_messages" DROP CONSTRAINT "session_messages_project_id_projects_id_fk";
--> statement-breakpoint
DROP INDEX "session_messages_project_idx";--> statement-breakpoint
ALTER TABLE "session_agents" ALTER COLUMN "session_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "session_messages" ALTER COLUMN "id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "session_messages" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "session_messages" ALTER COLUMN "session_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "session_messages" ALTER COLUMN "text" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "session_messages" ALTER COLUMN "text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "domain_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "kind" text DEFAULT 'text';--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "agent_checkpoints" ADD CONSTRAINT "agent_checkpoints_session_id_project_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."project_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_checkpoints_session_segment_idx" ON "agent_checkpoints" USING btree ("session_id","segment_index");--> statement-breakpoint
CREATE INDEX "agent_checkpoints_session_created_idx" ON "agent_checkpoints" USING btree ("session_id","created_at" desc);--> statement-breakpoint
ALTER TABLE "session_agents" ADD CONSTRAINT "session_agents_session_id_project_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."project_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_session_id_project_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."project_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_parent_id_session_messages_domain_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."session_messages"("domain_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_sessions_project_idx" ON "project_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_sessions_project_origin_idx" ON "project_sessions" USING btree ("project_id","origin");--> statement-breakpoint
CREATE INDEX "session_agents_project_idx" ON "session_agents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "session_messages_session_parent_idx" ON "session_messages" USING btree ("session_id","parent_id");--> statement-breakpoint
ALTER TABLE "session_messages" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_domain_id_unique" UNIQUE("domain_id");