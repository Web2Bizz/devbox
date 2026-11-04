CREATE TABLE "session_agents" (
	"session_id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"agent_id" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_sessions" ADD COLUMN "origin" text DEFAULT 'upstream' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_agents" ADD CONSTRAINT "session_agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_messages_session_idx" ON "session_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "session_messages_project_idx" ON "session_messages" USING btree ("project_id");