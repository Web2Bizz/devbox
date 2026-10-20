/**
 * Organizations e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist (tsc decorator metadata; do not run via
 * `bun test` on TS sources). Usage: `bun run build && bun dist/organizations/organizations.e2e.js`.
 *
 * Strict Postgres: needs a live PG (TEST_DATABASE_URL wins, DATABASE_URL
 * fallback; drizzle/0001..0004 applied automatically) — runs the full suite
 * (org CRUD, single-maintainer 409/400s, last-maintainer guards, invite
 * accept, project scope for sessions/chats/files, Bearer guards, users/:id
 * privacy, X-Robots-Tag noindex). Without a reachable PG it asserts the
 * outage surface instead: org endpoints answer 503 EXTERNAL_UNAVAILABLE
 * (Retry-After 30, envelope { code, message, correlationId }), Bearer-less
 * private reads answer 401, and /health reports db:down.
 * Never logs secrets (tokens appear only as Bearer headers / opaque ids).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Deterministic env — BEFORE AppModule import (ConfigModule.validate at import).
// NOTE: DATABASE_URL is resolved inside main() (TEST_DATABASE_URL seam) —
process.env.APP_BACKEND_PORT ??= "3000";
process.env.REQUEST_TIMEOUT_MS = "2000";
process.env.OPENCODE_URL = "http://127.0.0.1:9";
process.env.JWT_ACCESS_SECRET = "e2e-access-secret-not-real-0123456789";
process.env.JWT_REFRESH_SECRET = "e2e-refresh-secret-not-real-0123456789";
process.env.JWT_ACCESS_TTL = "15m";
process.env.JWT_REFRESH_TTL = "7d";
process.env.AUTH_LEGACY_MOCK_FALLBACK = "false";
process.env.ORG_INVITE_TTL_SEC = "86400";

async function main(): Promise<void> {
  const { resolveTestDb, applyTestMigrations } =
    await import("../db/e2e-db");
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
  console.log(`[organizations e2e] db mode: ${testDb.mode}`);

  // Disk-first surface: isolate on-disk repos in a tmp REPOS_ROOT so the
  // suite never touches the developer's real jail. Set before app boot
  // (WorkspacePathService reads process.env per call; env validation runs
  // at NestFactory.create).
  const reposRoot = await mkdtemp(path.join(tmpdir(), "devbox-orgs-e2e-"));
  process.env.REPOS_ROOT = reposRoot;
  console.log(`[organizations e2e] REPOS_ROOT: ${reposRoot}`);

  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../app.module");
  const { configureApp } = await import("../app.setup");

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

  try {
    if (testDb.mode === "unreachable") {
      // No live PG — assert the strict outage surface (no memory fallback).
      // A hand-signed access token (TokenService.sign is pure, no DB) gets
      // past JwtAuthGuard so the 503 below proves the SERVICE denies with
      // EXTERNAL_UNAVAILABLE — not the guard with 401.
      const { TokenService } = await import("../auth/token.service");
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
          email: "probe@devbox.local",
          typ: "access",
        },
        process.env.JWT_ACCESS_SECRET as string,
        900,
      ).token;
      await check(
        "POST /api/v1/organizations without PG → 503 EXTERNAL_UNAVAILABLE",
        async () => {
          const cid = "e2e-orgs-503-0001";
          const res = await fetch(`${base}/api/v1/organizations`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-correlation-id": cid,
              authorization: `Bearer ${probe}`,
            },
            body: JSON.stringify({ name: "acme" }),
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

      await check(
        "GET /api/v1/organizations/:id without PG → 503 (member gate needs PG)",
        async () => {
          const res = await fetch(
            `${base}/api/v1/organizations/123e4567-e89b-12d3-a456-426614174005`,
            auth(probe),
          );
          assert.equal(res.status, 503);
          assert.equal(
            ((await readJson(res)) as { code?: string }).code,
            "EXTERNAL_UNAVAILABLE",
          );
        },
      );

      await check("GET /api/v1/organizations without Bearer → 401", async () => {
        const res = await fetch(`${base}/api/v1/organizations`);
        assert.equal(res.status, 401);
        assert.equal(
          ((await readJson(res)) as { code?: string }).code,
          "unauthorized",
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
      // Live PG — full suite (tables migrated + cleared above).
      const { OrganizationsService } = await import("./organizations.service");
      const { ProjectsService } = await import("../projects/projects.service");
      const { UsersService } = await import("../auth/users.service");
      const { TokenService } = await import("../auth/token.service");
      const orgs = app.get(OrganizationsService, { strict: false }) as {
        clearAllForTests: () => Promise<void>;
      };
      const projects = app.get(ProjectsService, { strict: false }) as {
        clearAllForTests: () => Promise<void>;
      };
      const users = app.get(UsersService, { strict: false }) as {
        clearAllForTests: () => Promise<void>;
      };
      const tokens = app.get(TokenService, { strict: false }) as {
        clearAllForTests: () => void;
      };
      await orgs.clearAllForTests();
      await projects.clearAllForTests();
      await users.clearAllForTests();
      tokens.clearAllForTests();

      async function register(
        tag: string,
      ): Promise<{ id: string; token: string }> {
        const res = await fetch(
          `${base}/api/v1/auth/register`,
          json({
            firstName: "E2e",
            lastName: tag,
            email: `orgs-e2e-${tag}@devbox.local`,
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

      const a = await register("alice");
      const b = await register("bob");
      const c = await register("carol");
      assert.ok(a.id && b.id && c.id);

      let orgId = "";

      await check("POST /api/v1/organizations 201 (+ noindex)", async () => {
        const res = await fetch(
          `${base}/api/v1/organizations`,
          json({ name: "acme" }, "POST", a.token),
        );
        assert.equal(res.status, 201);
        const body = (await readJson(res)) as {
          id?: string;
          name?: string;
          isPrivate?: boolean;
          ownerId?: string;
        };
        assert.ok(body.id);
        assert.equal(body.name, "acme");
        assert.equal(body.isPrivate, true);
        assert.equal(body.ownerId, a.id);
        assert.equal(res.headers.get("x-robots-tag"), "noindex");
        orgId = body.id as string;
      });

      await check("GET /api/v1/organizations lists caller org (noindex)", async () => {
        const res = await fetch(`${base}/api/v1/organizations`, auth(a.token));
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as Array<{ id?: string }>;
        assert.ok(body.some((o) => o.id === orgId));
        assert.equal(res.headers.get("x-robots-tag"), "noindex");
      });

      await check("stranger GET org → 404 (no leak) + member list empty", async () => {
        const single = await fetch(
          `${base}/api/v1/organizations/${orgId}`,
          auth(b.token),
        );
        assert.equal(single.status, 404);
        const listed = await fetch(
          `${base}/api/v1/organizations`,
          auth(b.token),
        );
        assert.equal(listed.status, 200);
        assert.deepEqual(await readJson(listed), []);
      });

      await check("stranger PATCH org → 404; owner PATCH → 200", async () => {
        const denied = await fetch(
          `${base}/api/v1/organizations/${orgId}`,
          json({ description: "hijack" }, "PATCH", b.token),
        );
        assert.equal(denied.status, 404);
        const ok = await fetch(
          `${base}/api/v1/organizations/${orgId}`,
          json({ description: "Acme team org" }, "PATCH", a.token),
        );
        assert.equal(ok.status, 200);
        assert.equal(
          ((await readJson(ok)) as { description?: string }).description,
          "Acme team org",
        );
      });

      await check("add B as user 201; second maintainer → 409", async () => {
        const added = await fetch(
          `${base}/api/v1/organizations/${orgId}/members`,
          json({ userId: b.id, role: "user" }, "POST", a.token),
        );
        assert.equal(added.status, 201);
        assert.equal(
          ((await readJson(added)) as { role?: string }).role,
          "user",
        );
        const clash = await fetch(
          `${base}/api/v1/organizations/${orgId}/members`,
          json({ userId: c.id, role: "maintainer" }, "POST", a.token),
        );
        assert.equal(clash.status, 409);
        const promote = await fetch(
          `${base}/api/v1/organizations/${orgId}/members/${b.id}`,
          json({ role: "maintainer" }, "PATCH", a.token),
        );
        assert.equal(promote.status, 409);
      });

      await check("plain member mutation → 403", async () => {
        const res = await fetch(
          `${base}/api/v1/organizations/${orgId}/members`,
          json({ userId: c.id, role: "user" }, "POST", b.token),
        );
        assert.equal(res.status, 403);
      });

      await check("remove last maintainer → 400; demote last → 400", async () => {
        const rm = await fetch(
          `${base}/api/v1/organizations/${orgId}/members/${a.id}`,
          { method: "DELETE", ...auth(a.token) },
        );
        assert.equal(rm.status, 400);
        const demote = await fetch(
          `${base}/api/v1/organizations/${orgId}/members/${a.id}`,
          json({ role: "user" }, "PATCH", a.token),
        );
        assert.equal(demote.status, 400);
      });

      let inviteToken = "";
      await check("maintainer mints user invite 201; C accepts 200", async () => {
        const minted = await fetch(
          `${base}/api/v1/organizations/${orgId}/invites`,
          json({ role: "user" }, "POST", a.token),
        );
        assert.equal(minted.status, 201);
        const invite = (await readJson(minted)) as {
          token?: string;
          role?: string;
        };
        assert.ok(invite.token);
        assert.equal(invite.role, "user");
        inviteToken = invite.token as string;
        const accepted = await fetch(
          `${base}/api/v1/organizations/invites/accept`,
          json({ token: inviteToken }, "POST", c.token),
        );
        assert.equal(accepted.status, 200);
        assert.equal(
          ((await readJson(accepted)) as { userId?: string }).userId,
          c.id,
        );
      });

      await check("invite single-use: replay → 404", async () => {
        const replay = await fetch(
          `${base}/api/v1/organizations/invites/accept`,
          json({ token: inviteToken }, "POST", c.token),
        );
        assert.equal(replay.status, 404);
      });

      let projectId = "";
      let sessionId = "";
      await check("link project → member sessions/files pass, stranger 404", async () => {
        const created = await fetch(
          `${base}/api/v1/projects`,
          json({ name: "org-project", ownerId: a.id }),
        );
        assert.equal(created.status, 201);
        projectId = ((await readJson(created)) as { id?: string }).id as string;
        const link = await fetch(
          `${base}/api/v1/organizations/${orgId}/projects/${projectId}`,
          { method: "POST", ...auth(a.token) },
        );
        assert.equal(link.status, 204);
        const relink = await fetch(
          `${base}/api/v1/organizations/${orgId}/projects/${projectId}`,
          { method: "POST", ...auth(a.token) },
        );
        assert.equal(relink.status, 409);
        // Org member (B) passes the scope gate…
        const made = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions`,
          json({}, "POST", b.token),
        );
        assert.equal(made.status, 201);
        sessionId = ((await readJson(made)) as { id?: string }).id as string;
        const files = await fetch(
          `${base}/api/v1/projects/${projectId}/files?path=.&depth=1`,
          auth(b.token),
        );
        assert.equal(files.status, 200);
        assert.equal(files.headers.get("x-robots-tag"), "noindex");
        // …stranger (fresh D) gets 404 with no existence leak.
        const d = await register("dave");
        const deniedGet = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions/${sessionId}`,
          auth(d.token),
        );
        assert.equal(deniedGet.status, 404);
        const deniedPost = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions`,
          json({}, "POST", d.token),
        );
        assert.equal(deniedPost.status, 404);
        const deniedFiles = await fetch(
          `${base}/api/v1/projects/${projectId}/files?path=.&depth=1`,
          auth(d.token),
        );
        assert.equal(deniedFiles.status, 404);
      });

      await check("user-space project: owner passes, non-owner 404", async () => {
        const created = await fetch(
          `${base}/api/v1/projects`,
          json({ name: "solo-project", ownerId: a.id }),
        );
        assert.equal(created.status, 201);
        const soloId = ((await readJson(created)) as { id?: string }).id as string;
        const ownerOk = await fetch(
          `${base}/api/v1/projects/${soloId}/sessions`,
          json({}, "POST", a.token),
        );
        assert.equal(ownerOk.status, 201);
        const stranger = await fetch(
          `${base}/api/v1/projects/${soloId}/sessions`,
          json({}, "POST", b.token),
        );
        assert.equal(stranger.status, 404);
      });

      await check("unlink restores owner-only scope", async () => {
        const unlink = await fetch(
          `${base}/api/v1/organizations/${orgId}/projects/${projectId}`,
          { method: "DELETE", ...auth(a.token) },
        );
        assert.equal(unlink.status, 204);
        const memberDenied = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions/${sessionId}`,
          auth(b.token),
        );
        assert.equal(memberDenied.status, 404);
        const ownerOk = await fetch(
          `${base}/api/v1/projects/${projectId}/sessions/${sessionId}`,
          auth(a.token),
        );
        assert.equal(ownerOk.status, 200);
      });

      await check("GET /api/v1/users/:id — own 200, чужой 403, без токена 401", async () => {
        const own = await fetch(`${base}/api/v1/users/${a.id}`, auth(a.token));
        assert.equal(own.status, 200);
        const profile = (await readJson(own)) as {
          id?: string;
          email?: string;
          passwordHash?: string;
        };
        assert.equal(profile.id, a.id);
        assert.ok(!("passwordHash" in profile));
        assert.equal(own.headers.get("x-robots-tag"), "noindex");
        const чужой = await fetch(`${base}/api/v1/users/${b.id}`, auth(a.token));
        assert.equal(чужой.status, 403);
        const anon = await fetch(`${base}/api/v1/users/${a.id}`);
        assert.equal(anon.status, 401);
      });

      await check("member delete org → 403; maintainer delete → 204", async () => {
        const denied = await fetch(`${base}/api/v1/organizations/${orgId}`, {
          method: "DELETE",
          ...auth(b.token),
        });
        assert.equal(denied.status, 403);
        const ok = await fetch(`${base}/api/v1/organizations/${orgId}`, {
          method: "DELETE",
          ...auth(a.token),
        });
        assert.equal(ok.status, 204);
        const gone = await fetch(
          `${base}/api/v1/organizations/${orgId}`,
          auth(a.token),
        );
        assert.equal(gone.status, 404);
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
      if (root.includes("devbox-orgs-e2e-")) {
        await rm(root, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  console.log(`\norganizations e2e: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`organizations e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
