/**
 * Projects e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist (tsc decorator metadata; do not run via
 * `bun test` on TS sources). Usage: `bun run build && bun dist/projects/projects.e2e.js`.
 *
 * Strict Postgres: needs a live PG (TEST_DATABASE_URL wins, DATABASE_URL
 * fallback; drizzle/0001 applied automatically) — runs the full CRUD suite.
 * Without a reachable PG it asserts the outage surface instead: DB
 * endpoints answer 503 EXTERNAL_UNAVAILABLE (Retry-After 30, envelope
 * { code, message, correlationId }) and /health reports db:down.
 * Never logs secrets.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Deterministic env — BEFORE AppModule import (ConfigModule.validate at import).
// NOTE: DATABASE_URL is resolved inside main() (TEST_DATABASE_URL seam) —
process.env.APP_BACKEND_PORT ??= "3000";
process.env.REQUEST_TIMEOUT_MS = "2000";
process.env.OPENCODE_URL = "http://127.0.0.1:9";

async function main(): Promise<void> {
  const { resolveTestDb, applyTestMigrations } =
    await import("../db/e2e-db.js");
  const testDb = await resolveTestDb(
    process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  );
  process.env.DATABASE_URL = testDb.url;
  for (const key of [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "POSTGRES_HOST",
  ]) {
    delete process.env[key];
  }
  if (testDb.mode === "live") {
    await applyTestMigrations(testDb.url);
  }
  console.log(`[projects e2e] db mode: ${testDb.mode}`);

  // Disk-first surface: isolate on-disk repos in a tmp REPOS_ROOT so the
  // suite never touches the developer's real jail. Set before app boot
  // (WorkspacePathService reads process.env per call; env validation runs
  // at NestFactory.create).
  const reposRoot = await mkdtemp(path.join(tmpdir(), "devbox-repos-e2e-"));
  process.env.REPOS_ROOT = reposRoot;
  console.log(`[projects e2e] REPOS_ROOT: ${reposRoot}`);

  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../app.module.js");
  const { configureApp } = await import("../app.setup.js");

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  const base = await app.getUrl();
  let passed = 0;
  let failed = 0;

  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      passed += 1;
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL - ${name}: ${(err as Error).message}`);
    }
  }

  const json = (obj: unknown, method = "POST") => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });
  const readJson = async (res: Response): Promise<unknown> =>
    (await res.json().catch(() => null)) as unknown;

  try {
    if (testDb.mode === "unreachable") {
      // No live PG — assert the strict outage surface (no memory fallback).
      await check(
        "POST /api/v1/projects without PG → 503 EXTERNAL_UNAVAILABLE",
        async () => {
          const cid = "e2e-projects-503-0001";
          const res = await fetch(`${base}/api/v1/projects`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-correlation-id": cid,
            },
            body: JSON.stringify({ name: "demo" }),
          });
          assert.equal(res.status, 503);
          const body = (await readJson(res)) as {
            code?: string;
            message?: string;
            correlationId?: string;
          };
          assert.equal(body.code, "EXTERNAL_UNAVAILABLE");
          assert.equal(
            body.message,
            "сервис временно недоступен, повторите позже",
          );
          assert.equal(body.correlationId, cid);
          assert.equal(res.headers.get("x-correlation-id"), cid);
          assert.equal(res.headers.get("retry-after"), "30");
        },
      );

      await check("GET /api/v1/projects without PG → 503", async () => {
        const res = await fetch(`${base}/api/v1/projects`);
        assert.equal(res.status, 503);
        assert.equal(
          ((await readJson(res)) as { code?: string }).code,
          "EXTERNAL_UNAVAILABLE",
        );
      });

      await check("GET /health reports db:down (still 200)", async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { status?: string; db?: string };
        assert.equal(body.status, "ok");
        assert.equal(body.db, "down");
      });
    } else {
      // Live PG — full CRUD suite (tables migrated + cleared above).
      const { ProjectsService } = await import("./projects.service.js");
      const registry = app.get(ProjectsService, { strict: false }) as {
        clearAllForTests: () => Promise<void>;
      };
      await registry.clearAllForTests();

      let projectId = "";
      let chatId = "";
      let sessionId = "";

      await check("POST /api/v1/projects 201", async () => {
        const res = await fetch(
          `${base}/api/v1/projects`,
          json({ name: "demo" }),
        );
        assert.equal(res.status, 201);
        const body = (await readJson(res)) as {
          id?: string;
          name?: string;
          corrupted?: boolean;
        };
        assert.ok(body.id);
        assert.equal(body.name, "demo");
        assert.equal(body.corrupted, false);
        projectId = body.id as string;
      });

      await check("POST initializes a valid git repo on disk", async () => {
        const { WorkspacePathService } =
          await import("../workspaces/workspace-path.service.js");
        const { SYSTEM_OWNER_UUID } = await import("./projects.service.js");
        const { isValidGitRepo } = await import("../repos/repos-git.util.js");
        const paths = new WorkspacePathService();
        // No ownerId → SYSTEM_OWNER_UUID home (same mapping as ProjectsService).
        const resolved = await paths.resolveUser(SYSTEM_OWNER_UUID, projectId);
        const gitDir = await stat(path.join(resolved.absRepo, ".git"));
        assert.equal(gitDir.isDirectory(), true);
        const check = await isValidGitRepo(resolved.absRepo);
        assert.equal(check.ok, true);
      });

      await check("POST /api/v1/projects {} → 400", async () => {
        const res = await fetch(`${base}/api/v1/projects`, json({}));
        assert.equal(res.status, 400);
      });

      await check("GET /api/v1/projects lists created", async () => {
        const res = await fetch(`${base}/api/v1/projects`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as Array<{
          id?: string;
          corrupted?: boolean;
        }>;
        assert.ok(body.some((p) => p.id === projectId));
        assert.equal(
          body.find((p) => p.id === projectId)?.corrupted,
          false,
        );
      });

      await check("missing repo dir → GET/list report corrupted:true", async () => {
        const { WorkspacePathService } =
          await import("../workspaces/workspace-path.service.js");
        const { SYSTEM_OWNER_UUID } = await import("./projects.service.js");
        const paths = new WorkspacePathService();
        const resolved = await paths.resolveUser(SYSTEM_OWNER_UUID, projectId);
        await rm(resolved.absRepo, { recursive: true, force: true });

        const single = await fetch(`${base}/api/v1/projects/${projectId}`);
        assert.equal(single.status, 200);
        const one = (await readJson(single)) as {
          corrupted?: boolean;
          corruptedReason?: string | null;
        };
        assert.equal(one.corrupted, true);
        assert.ok(typeof one.corruptedReason === "string");

        const listed = await fetch(`${base}/api/v1/projects`);
        assert.equal(listed.status, 200);
        const items = (await readJson(listed)) as Array<{
          id?: string;
          corrupted?: boolean;
        }>;
        assert.equal(
          items.find((p) => p.id === projectId)?.corrupted,
          true,
        );

        // Restore the repo dir so the remaining suite runs uncorrupted
        // (delete the row and re-create disk-first via the API).
        const del = await fetch(`${base}/api/v1/projects/${projectId}`, {
          method: "DELETE",
        });
        assert.equal(del.status, 204);
        const recreated = await fetch(
          `${base}/api/v1/projects`,
          json({ name: "demo" }),
        );
        assert.equal(recreated.status, 201);
        const reBody = (await readJson(recreated)) as {
          id?: string;
          corrupted?: boolean;
        };
        assert.equal(reBody.corrupted, false);
        projectId = reBody.id as string;
      });

      await check("POST chat under project 201", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/chats`,
          json({ title: "c1" }),
        );
        assert.equal(res.status, 201);
        const body = (await readJson(res)) as {
          id?: string;
          projectId?: string;
        };
        assert.equal(body.projectId, projectId);
        chatId = body.id as string;
      });

      await check("POST session bound to project+chat 201", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions`,
          json({ chatId, status: "open" }),
        );
        assert.equal(res.status, 201);
        const body = (await readJson(res)) as { id?: string; chatId?: string };
        assert.equal(body.chatId, chatId);
        sessionId = body.id as string;
      });

      await check("POST session with foreign chatId → 400/404", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions`,
          json({ chatId: "00000000-0000-4000-8000-000000000000" }),
        );
        assert.ok(res.status === 400 || res.status === 404);
      });

      await check("PATCH session close 200", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions/${sessionId}/close`,
          { method: "PATCH" },
        );
        assert.equal(res.status, 200);
        assert.equal(
          ((await readJson(res)) as { status?: string }).status,
          "closed",
        );
      });

      await check("POST github-link 200 + GET status linked", async () => {
        const link = await fetch(
          `${base}/api/v1/projects/${projectId}/github-link`,
          json({ owner: "acme", repo: "demo", branch: "main" }),
        );
        assert.equal(link.status, 200);
        const status = await fetch(
          `${base}/api/v1/projects/${projectId}/github-link`,
        );
        assert.equal(status.status, 200);
        const body = (await readJson(status)) as {
          linked?: boolean;
          url?: string;
        };
        assert.equal(body.linked, true);
        assert.match(body.url ?? "", /github\.com\/acme\/demo/);
      });

      await check("POST github-link bad owner → 400", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/github-link`,
          json({ owner: "bad owner!!", repo: "demo" }),
        );
        assert.equal(res.status, 400);
      });

      await check("GET files depth=1 200 with children", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/files?path=.&depth=1`,
        );
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as {
          type?: string;
          children?: unknown[];
        };
        assert.equal(body.type, "dir");
        assert.ok(Array.isArray(body.children));
      });

      await check("GET files traversal → 403", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/files?path=..%2F..%2Fetc&depth=1`,
        );
        assert.equal(res.status, 403);
      });

      await check("DELETE github-link 200 unlinked", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/github-link`,
          {
            method: "DELETE",
          },
        );
        assert.equal(res.status, 200);
      });

      await check("DELETE project cascades (chats gone) 204", async () => {
        const del = await fetch(`${base}/api/v1/projects/${projectId}`, {
          method: "DELETE",
        });
        assert.equal(del.status, 204);
        const chats = await fetch(`${base}/api/v1/projects/${projectId}/chats`);
        assert.equal(chats.status, 404);
      });

      await check("DELETE removes the repo dir from disk", async () => {
        const res = await fetch(
          `${base}/api/v1/projects`,
          json({ name: "disk-cleanup-probe" }),
        );
        assert.equal(res.status, 201);
        const probe = (await readJson(res)) as { id?: string };
        const probeId = probe.id as string;
        const { WorkspacePathService } =
          await import("../workspaces/workspace-path.service.js");
        const { SYSTEM_OWNER_UUID } = await import("./projects.service.js");
        const paths = new WorkspacePathService();
        const resolved = await paths.resolveUser(SYSTEM_OWNER_UUID, probeId);
        assert.equal((await stat(resolved.absRepo)).isDirectory(), true);
        const del = await fetch(`${base}/api/v1/projects/${probeId}`, {
          method: "DELETE",
        });
        assert.equal(del.status, 204);
        await assert.rejects(() => stat(resolved.absRepo));
      });

      await check("GET /health still ok", async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        assert.equal(
          ((await readJson(res)) as { status?: string }).status,
          "ok",
        );
      });
    } // else live
  } finally {
    await app.close();
    // Best-effort cleanup of the isolated tmp jail (never masks results).
    try {
      const root = process.env.REPOS_ROOT ?? "";
      if (root.includes("devbox-repos-e2e-")) {
        await rm(root, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  console.log(`\nprojects e2e: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`projects e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
