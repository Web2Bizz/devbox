/**
 * Projects e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist (tsc decorator metadata; do not run via
 * `bun test` on TS sources). Usage: `bun run build && bun dist/projects/projects.e2e.js`.
 *
 * Strict Postgres: needs a live PG (TEST_DATABASE_URL wins, DATABASE_URL
 * fallback; drizzle/0001 applied automatically) — runs the full CRUD suite.
 * Without a reachable PG it asserts the outage surface instead: guarded DB
 * endpoints answer 503 EXTERNAL_UNAVAILABLE (Retry-After 30, envelope
 * { code, message, correlationId }) for Bearer callers, anonymous answers
 * 401, and /health reports db:down.
 * Security (C1): class-level JwtAuthGuard (anon → 401), ownerId forced from
 * the Bearer identity (body ownerId ignored), GET/PATCH/DELETE :id gated
 * through assertProjectAccess (strangers → 404); github-link write paths
 * are 410 Gone (PATCH github fields instead).
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
// Guarded routes (C1): Bearer past JwtAuthGuard (register flow mints real
// tokens live; the unreachable branch hand-signs a probe like the orgs suite).
process.env.JWT_ACCESS_SECRET = "e2e-access-secret-not-real-0123456789";
process.env.JWT_REFRESH_SECRET = "e2e-refresh-secret-not-real-0123456789";
process.env.JWT_ACCESS_TTL = "15m";
process.env.JWT_REFRESH_TTL = "7d";
process.env.AUTH_LEGACY_MOCK_FALLBACK = "false";

async function main(): Promise<void> {
  const { resolveTestDb, applyTestMigrations } =
    await import("../../common/db/e2e-db");
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
  const reposRoot = await mkdtemp(path.join(tmpdir(), "rush-code-repos-e2e-"));
  process.env.REPOS_ROOT = reposRoot;
  console.log(`[projects e2e] REPOS_ROOT: ${reposRoot}`);

  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../../app/app.module");
  const { configureApp } = await import("../../app/app.setup");

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

  const json = (obj: unknown, method = "POST", token?: string) => ({
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(obj),
  });
  const auth = (token?: string, extra?: Record<string, string>) => ({
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
  });
  const readJson = async (res: Response): Promise<unknown> =>
    (await res.json().catch(() => null)) as unknown;

  async function register(
    tag: string,
  ): Promise<{ id: string; token: string }> {
    const res = await fetch(
      `${base}/api/v1/auth/register`,
      json({
        firstName: "E2e",
        lastName: tag,
        email: `projects-e2e-${tag}@rush-code.local`,
        password: "s3cret-p4ss",
      }),
    );
    assert.equal(res.status, 201);
    const body = (await readJson(res)) as {
      user?: { id?: string };
      accessToken?: string;
    };
    return { id: body.user?.id as string, token: body.accessToken as string };
  }

  try {
    if (testDb.mode === "unreachable") {
      // No live PG — assert the strict outage surface (no memory fallback).
      // A hand-signed access token (TokenService.sign is pure, no DB) gets
      // past JwtAuthGuard so the 503s below prove the SERVICE denies with
      // EXTERNAL_UNAVAILABLE — not the guard with 401 (anon is asserted
      // separately).
      const { TokenService } = await import("../../auth/token.service");
      const tokens = app.get(TokenService, { strict: false }) as {
        sign: (
          claims: Record<string, unknown>,
          secret: string,
          ttlSec: number,
        ) => { token: string };
      };
      const probe = tokens.sign(
        {
          sub: "123e4567-e89b-12d3-a456-426614174001",
          email: "probe@rush-code.local",
          typ: "access",
        },
        process.env.JWT_ACCESS_SECRET as string,
        900,
      ).token;
      await check(
        "POST /api/v1/projects without PG → 503 EXTERNAL_UNAVAILABLE",
        async () => {
          const cid = "e2e-projects-503-0001";
          const res = await fetch(`${base}/api/v1/projects`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-correlation-id": cid,
              authorization: `Bearer ${probe}`,
            },
            body: JSON.stringify({
              name: "demo",
              orgId: "123e4567-e89b-12d3-a456-426614174005",
            }),
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

      await check("POST /api/v1/projects anon → 401", async () => {
        const res = await fetch(
          `${base}/api/v1/projects`,
          json({ name: "demo" }),
        );
        assert.equal(res.status, 401);
        assert.equal(
          ((await readJson(res)) as { code?: string }).code,
          "unauthorized",
        );
      });

      await check("GET /api/v1/projects anon → 401 (guard before ORG_REQUIRED)", async () => {
        const res = await fetch(`${base}/api/v1/projects`);
        assert.equal(res.status, 401);
      });

      await check("GET /api/v1/projects with Bearer → 400 ORG_REQUIRED (canonical list is nested)", async () => {
        const res = await fetch(
          `${base}/api/v1/projects`,
          auth(probe),
        );
        assert.equal(res.status, 400);
        assert.equal(
          ((await readJson(res)) as { code?: string }).code,
          "ORG_REQUIRED",
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
      const { ProjectsService } = await import("./projects.service");
      const { UsersService } = await import("../../users/users.service");
      const { TokenService } = await import("../../auth/token.service");
      const registry = app.get(ProjectsService, { strict: false }) as {
        clearAllForTests: () => Promise<void>;
      };
      const users = app.get(UsersService, { strict: false }) as {
        clearAllForTests: () => Promise<void>;
      };
      const tokens = app.get(TokenService, { strict: false }) as {
        clearAllForTests: () => void;
      };
      await registry.clearAllForTests();
      await users.clearAllForTests();
      tokens.clearAllForTests();

      const owner = await register("owner");
      const stranger = await register("stranger");
      assert.ok(owner.id && stranger.id);

      // Org home for the 1:1 project rows (orgId required on create).
      let orgId = "";
      await check("POST /api/v1/organizations 201 (project home)", async () => {
        const res = await fetch(
          `${base}/api/v1/organizations`,
          json({ name: "proj-e2e" }, "POST", owner.token),
        );
        assert.equal(res.status, 201);
        orgId = ((await readJson(res)) as { id?: string }).id as string;
        assert.ok(orgId);
      });

      let projectId = "";
      let chatId = "";
      let sessionId = "";

      await check("POST /api/v1/projects 201 (owner forced from Bearer)", async () => {
        // Spoof attempt: body ownerId=stranger.id is ignored (C1) — the row
        // is always owned by the Bearer identity.
        const res = await fetch(
          `${base}/api/v1/projects`,
          json(
            { name: "demo", orgId, ownerId: stranger.id },
            "POST",
            owner.token,
          ),
        );
        assert.equal(res.status, 201);
        const body = (await readJson(res)) as {
          id?: string;
          name?: string;
          ownerId?: string;
          corrupted?: boolean;
        };
        assert.ok(body.id);
        assert.equal(body.name, "demo");
        assert.equal(body.ownerId, owner.id);
        assert.equal(body.corrupted, false);
        projectId = body.id as string;
      });

      await check("anon GET :id → 401; stranger GET :id → 404 (no leak)", async () => {
        const anon = await fetch(`${base}/api/v1/projects/${projectId}`);
        assert.equal(anon.status, 401);
        assert.equal(
          ((await readJson(anon)) as { code?: string }).code,
          "unauthorized",
        );
        // Stranger is no org member → 404, the row's existence is not leaked.
        const denied = await fetch(
          `${base}/api/v1/projects/${projectId}`,
          auth(stranger.token),
        );
        assert.equal(denied.status, 404);
      });

      await check("PATCH :id owner → 200; stranger → 404", async () => {
        const denied = await fetch(
          `${base}/api/v1/projects/${projectId}`,
          json({ description: "hijack" }, "PATCH", stranger.token),
        );
        assert.equal(denied.status, 404);
        const ok = await fetch(
          `${base}/api/v1/projects/${projectId}`,
          json({ description: "owned" }, "PATCH", owner.token),
        );
        assert.equal(ok.status, 200);
        assert.equal(
          ((await readJson(ok)) as { description?: string }).description,
          "owned",
        );
      });

      await check("POST initializes a valid git repo on disk", async () => {
        const { WorkspacePathService } =
          await import("../../common/storage/workspace-path.service");
        const { isValidGitRepo } = await import("../../repos/repos-git.util");
        const paths = new WorkspacePathService();
        // Owner-forced row → owner user home (C1, no ownerless rows).
        const resolved = await paths.resolveUser(owner.id, projectId);
        const gitDir = await stat(path.join(resolved.absRepo, ".git"));
        assert.equal(gitDir.isDirectory(), true);
        const checkGit = await isValidGitRepo(resolved.absRepo);
        assert.equal(checkGit.ok, true);
      });

      await check("POST /api/v1/projects {} → 400", async () => {
        const res = await fetch(
          `${base}/api/v1/projects`,
          json({}, "POST", owner.token),
        );
        assert.equal(res.status, 400);
      });

      await check("GET nested list shows created (member-only)", async () => {
        const res = await fetch(
          `${base}/api/v1/organizations/${orgId}/projects`,
          auth(owner.token),
        );
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
        const denied = await fetch(
          `${base}/api/v1/organizations/${orgId}/projects`,
          auth(stranger.token),
        );
        assert.equal(denied.status, 404);
      });

      await check("missing repo dir → GET/list report corrupted:true", async () => {
        const { WorkspacePathService } =
          await import("../../common/storage/workspace-path.service");
        const paths = new WorkspacePathService();
        const resolved = await paths.resolveUser(owner.id, projectId);
        await rm(resolved.absRepo, { recursive: true, force: true });

        const single = await fetch(
          `${base}/api/v1/projects/${projectId}`,
          auth(owner.token),
        );
        assert.equal(single.status, 200);
        const one = (await readJson(single)) as {
          corrupted?: boolean;
          corruptedReason?: string | null;
        };
        assert.equal(one.corrupted, true);
        assert.ok(typeof one.corruptedReason === "string");

        const listed = await fetch(
          `${base}/api/v1/organizations/${orgId}/projects`,
          auth(owner.token),
        );
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
          ...auth(owner.token),
        });
        assert.equal(del.status, 204);
        const recreated = await fetch(
          `${base}/api/v1/projects`,
          json({ name: "demo", orgId }, "POST", owner.token),
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
          json({ title: "c1" }, "POST", owner.token),
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
          json({ chatId, status: "open" }, "POST", owner.token),
        );
        assert.equal(res.status, 201);
        const body = (await readJson(res)) as { id?: string; chatId?: string };
        assert.equal(body.chatId, chatId);
        sessionId = body.id as string;
      });

      await check("POST session with foreign chatId → 400/404", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions`,
          json(
            { chatId: "00000000-0000-4000-8000-000000000000" },
            "POST",
            owner.token,
          ),
        );
        assert.ok(res.status === 400 || res.status === 404);
      });

      await check("PATCH session close 200", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions/${sessionId}/close`,
          { method: "PATCH", ...auth(owner.token) },
        );
        assert.equal(res.status, 200);
        assert.equal(
          ((await readJson(res)) as { status?: string }).status,
          "closed",
        );
      });

      await check("POST github-link → 410 (use PATCH github fields)", async () => {
        const link = await fetch(
          `${base}/api/v1/projects/${projectId}/github-link`,
          json(
            { owner: "acme", repo: "demo", branch: "main" },
            "POST",
            owner.token,
          ),
        );
        assert.equal(link.status, 410);
        const patched = await fetch(
          `${base}/api/v1/projects/${projectId}`,
          json(
            { githubOwner: "acme", githubRepo: "demo" },
            "PATCH",
            owner.token,
          ),
        );
        assert.equal(patched.status, 200);
        const status = await fetch(
          `${base}/api/v1/projects/${projectId}/github-link`,
          auth(owner.token),
        );
        assert.equal(status.status, 200);
        const body = (await readJson(status)) as {
          linked?: boolean;
          url?: string;
        };
        assert.equal(body.linked, true);
        assert.match(body.url ?? "", /github\.com\/acme\/demo/);
      });

      await check("PATCH github fields bad owner → 400", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}`,
          json({ githubOwner: "bad owner!!" }, "PATCH", owner.token),
        );
        assert.equal(res.status, 400);
      });

      await check("GET files depth=1 200 with children", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/files?path=.&depth=1`,
          auth(owner.token),
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
          auth(owner.token),
        );
        assert.equal(res.status, 403);
      });

      await check("DELETE github-link → 410", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/${projectId}/github-link`,
          {
            method: "DELETE",
            ...auth(owner.token),
          },
        );
        assert.equal(res.status, 410);
      });

      await check("DELETE project soft-deletes (chats gone) 204", async () => {
        const del = await fetch(`${base}/api/v1/projects/${projectId}`, {
          method: "DELETE",
          ...auth(owner.token),
        });
        assert.equal(del.status, 204);
        const chats = await fetch(
          `${base}/api/v1/projects/${projectId}/chats`,
          auth(owner.token),
        );
        assert.equal(chats.status, 404);
      });

      await check("DELETE keeps the disk for restore (soft-delete, not rm)", async () => {
        const res = await fetch(
          `${base}/api/v1/projects`,
          json({ name: "disk-cleanup-probe", orgId }, "POST", owner.token),
        );
        assert.equal(res.status, 201);
        const probe = (await readJson(res)) as { id?: string };
        const probeId = probe.id as string;
        const { WorkspacePathService } =
          await import("../../common/storage/workspace-path.service");
        const paths = new WorkspacePathService();
        const resolved = await paths.resolveUser(owner.id, probeId);
        assert.equal((await stat(resolved.absRepo)).isDirectory(), true);
        const del = await fetch(`${base}/api/v1/projects/${probeId}`, {
          method: "DELETE",
          ...auth(owner.token),
        });
        assert.equal(del.status, 204);
        // Soft-delete hides the row by default but retains the disk…
        const hidden = await fetch(
          `${base}/api/v1/organizations/${orgId}/projects/${probeId}`,
          auth(owner.token),
        );
        assert.equal(hidden.status, 404);
        const visible = await fetch(
          `${base}/api/v1/organizations/${orgId}/projects/${probeId}?includeDeleted=true`,
          auth(owner.token),
        );
        assert.equal(visible.status, 200);
        assert.equal((await stat(resolved.absRepo)).isDirectory(), true);
        // …until restore brings it back (API only, no UI).
        const restored = await fetch(
          `${base}/api/v1/organizations/${orgId}/projects/${probeId}/restore`,
          { method: "POST", ...auth(owner.token) },
        );
        assert.equal(restored.status, 201);
        assert.equal(
          ((await readJson(restored)) as { status?: string }).status,
          "active",
        );
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
      if (root.includes("rush-code-repos-e2e-")) {
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
