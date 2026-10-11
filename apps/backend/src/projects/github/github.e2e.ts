/**
 * Github (multi-tenant App) e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist (tsc decorator metadata; do not run via
 * `bun test` on TS sources). Usage: `bun run build && bun dist/projects/github/github.e2e.js`.
 *
 * Covers:
 *  - Phase A (no GITHUB_APP_*): GET repos → 401, install-url → 503,
 *    webhook → 503, callback still binds (200, harmless without config),
 *    format-only github-link still 200 (no regression vs projects.e2e).
 *  - Phase B (APP_ID + PRIVATE_KEY + SLUG + WEBHOOK_SECRET, no legacy
 *    single-install, network stubbed): install-url 200, callback binds
 *    per-user installs, repos per-user 200 normalized, unknown user → 404
 *    GITHUB_NOT_INSTALLED, webhook verify (bad sig → 401, created preserves
 *    callback ownership, suspend → 401, unsuspend → 200, deleted → 404),
 *    per_page=999 / page=0 → 400 (zod query validation).
 *  - Phase C (legacy GITHUB_APP_INSTALLATION_ID dev fallback): default user
 *    repos → 200 via the fallback install, other users → 404.
 * Strict Postgres: needs a live PG (TEST_DATABASE_URL wins, DATABASE_URL
 * fallback; drizzle/0002 applied automatically). Without a reachable PG it
 * asserts the outage surface instead: the install callback answers 503
 * EXTERNAL_UNAVAILABLE (Retry-After 30, envelope { code, message,
 * correlationId }) and /health reports db:down.
 * Never logs secrets.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Deterministic env — BEFORE AppModule import (ConfigModule.validate at create).
// NOTE: DATABASE_URL is resolved inside main() (TEST_DATABASE_URL seam) —
process.env.APP_BACKEND_PORT ??= "3000";
process.env.REQUEST_TIMEOUT_MS = "2000";
process.env.OPENCODE_URL = "http://127.0.0.1:9";
for (const key of [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_API_URL",
]) {
  delete process.env[key];
}

const FIXTURE_REPOS = [
  {
    id: 1296269,
    name: "my-app",
    full_name: "acme/my-app",
    private: false,
    default_branch: "main",
    html_url: "https://github.com/acme/my-app",
    owner: { login: "acme" },
  },
  {
    id: 1296270,
    name: "secret-svc",
    full_name: "acme/secret-svc",
    private: true,
    default_branch: "trunk",
    html_url: "https://github.com/acme/secret-svc",
    owner: { login: "acme" },
  },
];

function signWebhook(raw: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
}

async function main(): Promise<void> {
  const { resolveTestDb, applyTestMigrations } =
    await import("../../db/e2e-db.js");
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
  console.log(`[github e2e] db mode: ${testDb.mode}`);

  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../../app.module.js");
  const { configureApp } = await import("../../app.setup.js");
  const { GithubAppService } = await import("./github-app.service.js");
  const { GithubInstallationsService } =
    await import("./github-installations.service.js");
  const { __setGithubFetchForTests } = await import("./github.service.js");

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

  function stubOctokitFetch(): { lastUrl: () => string } {
    let lastUrl = "";
    __setGithubFetchForTests((async (input: unknown) => {
      lastUrl = String(input);
      if (lastUrl.includes("/installation/repositories")) {
        return new Response(
          JSON.stringify({
            total_count: FIXTURE_REPOS.length,
            repositories: FIXTURE_REPOS,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ message: "not mocked" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
    return { lastUrl: () => lastUrl };
  }

  // --- Phase A: unconfigured -------------------------------------------------
  // Without a live PG only the outage surface is asserted (no memory fallback).
  if (testDb.mode === "unreachable") {
    const app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    const base = await app.getUrl();
    try {
      await check(
        "callback without PG → 503 EXTERNAL_UNAVAILABLE",
        async () => {
          const cid = "e2e-github-503-0001";
          const res = await fetch(
            `${base}/api/v1/projects/github/callback?installation_id=111&setup_action=install`,
            { headers: { "x-correlation-id": cid } },
          );
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

      await check("GET /health reports db:down (still 200)", async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { status?: string; db?: string };
        assert.equal(body.status, "ok");
        assert.equal(body.db, "down");
      });
    } finally {
      await app.close();
    }

    console.log(`\ngithub e2e: ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exit(1);
    return;
  }

  {
    const app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    const base = await app.getUrl();
    try {
      await check("GET repos w/o config → 401", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/repos`);
        assert.equal(res.status, 401);
        const body = (await readJson(res)) as { code?: string };
        assert.equal(body.code, "unauthorized");
      });

      await check("GET install-url w/o slug → 503", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/install-url`);
        assert.equal(res.status, 503);
      });

      await check("POST webhook w/o secret → 503", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/webhook`,
          json({ action: "created" }),
        );
        assert.equal(res.status, 503);
      });

      await check("GET callback binds (200, harmless w/o config)", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/callback?installation_id=111&setup_action=install`,
        );
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as {
          ok?: boolean;
          installationId?: number;
        };
        assert.equal(body.ok, true);
        assert.equal(body.installationId, 111);
      });

      await check("GET callback bad installation_id → 400", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/callback?installation_id=nope`,
        );
        assert.equal(res.status, 400);
      });

      await check(
        "github-link format-validation still 200 (no regression)",
        async () => {
          const created = (await (
            await fetch(`${base}/api/v1/projects`, json({ name: "gh-e2e" }))
          ).json()) as { id?: string };
          assert.ok(created.id);
          const link = await fetch(
            `${base}/api/v1/projects/${created.id}/github-link`,
            json({ owner: "acme", repo: "demo", branch: "main" }),
          );
          assert.equal(link.status, 200);
        },
      );
    } finally {
      await app.close();
    }
  }

  // --- Phase B: multi-tenant, no legacy fallback -----------------------------
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-key-not-real-never-logged";
  process.env.GITHUB_APP_SLUG = "devbox-test-app";
  const WEBHOOK_SECRET = "whsec_e2e_not_real";
  process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;

  {
    const app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);

    const appAuth = app.get(GithubAppService, { strict: false }) as {
      __setCachedTokenForTests: (
        token: string,
        expiresAtMs: number,
        installationId?: number,
      ) => void;
    };
    const installs = app.get(GithubInstallationsService, { strict: false }) as {
      clearAllForTests: () => Promise<void>;
    };
    await installs.clearAllForTests();
    // Seed per-installation tokens — the real
    // POST /app/installations/{id}/access_tokens is never hit in e2e.
    appAuth.__setCachedTokenForTests(
      "ghs_e2e_alice",
      Date.now() + 60 * 60_000,
      111,
    );
    appAuth.__setCachedTokenForTests(
      "ghs_e2e_carol",
      Date.now() + 60 * 60_000,
      333,
    );

    const seen = stubOctokitFetch();

    const postWebhook = async (
      payload: unknown,
      secret: string | null,
      event = "installation",
    ): Promise<Response> => {
      const raw = JSON.stringify(payload);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (secret !== null)
        headers["x-hub-signature-256"] = signWebhook(raw, secret);
      headers["x-github-event"] = event;
      return fetch(`${base}/api/v1/projects/github/webhook`, {
        method: "POST",
        headers,
        body: raw,
      });
    };

    await app.listen(0);
    const base = await app.getUrl();
    try {
      await check("GET install-url → 200 with slug", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/install-url`);
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as { url?: string };
        assert.equal(
          body.url,
          "https://github.com/apps/devbox-test-app/installations/new",
        );
      });

      await check("callback binds alice → install 111", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/callback?installation_id=111&setup_action=install&userId=alice`,
          { headers: { "x-user-id": "alice" } },
        );
        assert.equal(res.status, 200);
      });

      await check("GET repos alice → 200 normalized", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/repos?page=1&per_page=2`,
          {
            headers: { "x-user-id": "alice" },
          },
        );
        assert.equal(res.status, 200);
        const body = (await readJson(res)) as Array<{
          id?: number;
          owner?: string;
          name?: string;
          fullName?: string;
          private?: boolean;
          defaultBranch?: string;
          url?: string;
        }>;
        assert.equal(body.length, 2);
        assert.deepEqual(body[0], {
          id: 1296269,
          owner: "acme",
          name: "my-app",
          fullName: "acme/my-app",
          private: false,
          defaultBranch: "main",
          url: "https://github.com/acme/my-app",
        });
        assert.equal(body[1]?.private, true);
        assert.equal(body[1]?.defaultBranch, "trunk");
        assert.match(seen.lastUrl(), /per_page=2/);
      });

      await check(
        "GET repos query userId fallback (no header) → 200",
        async () => {
          const res = await fetch(
            `${base}/api/v1/projects/github/repos?userId=alice`,
          );
          assert.equal(res.status, 200);
        },
      );

      await check(
        "GET repos bob (no install) → 404 GITHUB_NOT_INSTALLED",
        async () => {
          const res = await fetch(`${base}/api/v1/projects/github/repos`, {
            headers: { "x-user-id": "bob" },
          });
          assert.equal(res.status, 404);
          const body = (await readJson(res)) as { code?: string };
          assert.equal(body.code, "GITHUB_NOT_INSTALLED");
        },
      );

      await check("GET repos per_page=999 → 400", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/repos?per_page=999`,
          {
            headers: { "x-user-id": "alice" },
          },
        );
        assert.equal(res.status, 400);
      });

      await check("GET repos page=0 → 400", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/repos?page=0`, {
          headers: { "x-user-id": "alice" },
        });
        assert.equal(res.status, 400);
      });

      await check("webhook w/o signature → 401", async () => {
        const res = await postWebhook(
          { action: "created", installation: { id: 222 } },
          null,
        );
        assert.equal(res.status, 401);
      });

      await check("webhook wrong secret → 401", async () => {
        const res = await postWebhook(
          { action: "created", installation: { id: 222 } },
          "wrong-secret",
        );
        assert.equal(res.status, 401);
      });

      await check("webhook ping (unknown shape) → 200 ack", async () => {
        const res = await postWebhook(
          { zen: "keep it simple" },
          WEBHOOK_SECRET,
          "ping",
        );
        assert.equal(res.status, 200);
      });

      await check(
        "callback carol → 333, webhook created keeps owner carol",
        async () => {
          const cb = await fetch(
            `${base}/api/v1/projects/github/callback?installation_id=333&setup_action=install`,
            { headers: { "x-user-id": "carol" } },
          );
          assert.equal(cb.status, 200);
          const wh = await postWebhook(
            {
              action: "created",
              installation: {
                id: 333,
                account: { login: "someone-else", type: "User" },
              },
            },
            WEBHOOK_SECRET,
          );
          assert.equal(wh.status, 200);
          const repos = await fetch(`${base}/api/v1/projects/github/repos`, {
            headers: { "x-user-id": "carol" },
          });
          assert.equal(repos.status, 200);
        },
      );

      await check("webhook suspend 333 → repos carol 401", async () => {
        const wh = await postWebhook(
          { action: "suspend", installation: { id: 333 } },
          WEBHOOK_SECRET,
        );
        assert.equal(wh.status, 200);
        const repos = await fetch(`${base}/api/v1/projects/github/repos`, {
          headers: { "x-user-id": "carol" },
        });
        assert.equal(repos.status, 401);
      });

      await check("webhook unsuspend 333 → repos carol 200", async () => {
        const wh = await postWebhook(
          { action: "unsuspend", installation: { id: 333 } },
          WEBHOOK_SECRET,
        );
        assert.equal(wh.status, 200);
        const repos = await fetch(`${base}/api/v1/projects/github/repos`, {
          headers: { "x-user-id": "carol" },
        });
        assert.equal(repos.status, 200);
      });

      await check("webhook deleted 333 → repos carol 404", async () => {
        const wh = await postWebhook(
          { action: "deleted", installation: { id: 333 } },
          WEBHOOK_SECRET,
        );
        assert.equal(wh.status, 200);
        const repos = await fetch(`${base}/api/v1/projects/github/repos`, {
          headers: { "x-user-id": "carol" },
        });
        assert.equal(repos.status, 404);
        const body = (await readJson(repos)) as { code?: string };
        assert.equal(body.code, "GITHUB_NOT_INSTALLED");
      });
    } finally {
      __setGithubFetchForTests(null);
      await app.close();
    }
  }

  // --- Phase C: legacy single-install dev fallback ---------------------------
  process.env.GITHUB_APP_INSTALLATION_ID = "789012";
  {
    const app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    const appAuth = app.get(GithubAppService, { strict: false }) as {
      __setCachedTokenForTests: (
        token: string,
        expiresAtMs: number,
        installationId?: number,
      ) => void;
    };
    const installs = app.get(GithubInstallationsService, { strict: false }) as {
      clearAllForTests: () => Promise<void>;
    };
    await installs.clearAllForTests();
    appAuth.__setCachedTokenForTests(
      "ghs_e2e_legacy",
      Date.now() + 60 * 60_000,
      789012,
    );
    stubOctokitFetch();
    await app.listen(0);
    const base = await app.getUrl();
    try {
      await check("legacy fallback: default user repos → 200", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/repos`);
        assert.equal(res.status, 200);
      });

      await check("legacy fallback: other user still 404", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/repos`, {
          headers: { "x-user-id": "stranger" },
        });
        assert.equal(res.status, 404);
      });
    } finally {
      __setGithubFetchForTests(null);
      await app.close();
    }
  }
  delete process.env.GITHUB_APP_INSTALLATION_ID;

  console.log(`\ngithub e2e: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`github e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
