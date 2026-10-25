--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "org_id" uuid REFERENCES "organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_org_idx" ON "projects" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_org_status_idx" ON "projects" ("org_id", "status");
--> statement-breakpoint
DO $$
DECLARE
  r RECORD;
  winners TEXT;
BEGIN
  -- 0-org projects: quarantine report (status=deleted, org_id NULL stays
  -- nullable until hand-triage; see migration report in docs).
  FOR r IN SELECT id, name FROM projects WHERE org_id IS NULL LOOP
    RAISE NOTICE 'quarantine: project % (%) has 0 orgs → status=deleted', r.id, r.name;
  END LOOP;
  UPDATE projects SET status = 'deleted', deleted_at = now()
    WHERE org_id IS NULL AND status = 'active';
  -- N-org projects (M2M leftovers): earliest link wins (by created_at).
  -- Report losers for hand-triage.
  FOR r IN
    SELECT p.project_id AS pid, array_agg(p.org_id ORDER BY p.created_at) AS orgs
    FROM projects_and_organizations p GROUP BY p.project_id HAVING count(*) > 1
  LOOP
    RAISE NOTICE 'earliest-winner: project % orgs % → winner %', r.pid, r.orgs, (r.orgs)[1];
    UPDATE projects SET org_id = (r.orgs)[1] WHERE id = r.pid AND org_id IS NULL;
  END LOOP;
  -- Single-link projects: adopt the link.
  UPDATE projects p SET org_id = l.org_id
    FROM projects_and_organizations l
    WHERE l.project_id = p.id AND p.org_id IS NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_org_name_unique_idx"
  ON "projects" ("org_id", lower("name")) WHERE status = 'active';
--> statement-breakpoint
DROP TABLE IF EXISTS "projects_and_organizations";
