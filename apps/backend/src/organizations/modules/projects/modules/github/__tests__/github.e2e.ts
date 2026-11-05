/**
 * Github (multi-tenant App) e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist (tsc decorator metadata; do not run via
 * `bun test` on TS sources). Usage: `bun run build && bun dist/organizations/modules/projects/modules/github/__tests__/github.e2e.js`.
 *
 * Covers:
 *  - Phase A (no GITHUB_APP_*): GET repos → 401, install-url → 503,
 *    webhook → 503, callback → 401 (app unconfigured),
 *    format-only github-link still 200 (no regression vs projects.e2e).
 *  - Phase B (APP_ID + PRIVATE_KEY + SLUG + WEBHOOK_SECRET, no legacy
 *    single-install, network stubbed): install-url 200, callback binds
 *    per-user installs, repos per-user 200 normalized, unknown user → 404
 *    GITHUB_NOT_INSTALLED, webhook verify (bad sig → 401, created preserves
 *    callback ownership, suspend → 401, unsuspend → 200, deleted → 404),
 *    per_page=999 / page=0 → 400 (zod query validation).
 *  - Phase C (legacy GITHUB_APP_INSTALLATION_ID is ignored): users without a
 *    registry binding get 404 GITHUB_NOT_INSTALLED (fail-closed).
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
// Identity-only auth (C2): callback/repos need a Bearer past JwtAuthGuard;
// userIds below ride as JWT subs (hand-signed, TokenService.sign is pure).
process.env.JWT_ACCESS_SECRET = "e2e-access-secret-not-real-0123456789";
process.env.JWT_REFRESH_SECRET = "e2e-refresh-secret-not-real-0123456789";
process.env.JWT_ACCESS_TTL = "15m";
process.env.JWT_REFRESH_TTL = "7d";
process.env.AUTH_LEGACY_MOCK_FALLBACK = "false";
for (const key of [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_STATE_SECRET",
  "GITHUB_API_URL",
]) {
  delete process.env[key];
}

const STATE_SECRET = "e2e-state-secret-not-real";
process.env.GITHUB_STATE_SECRET = STATE_SECRET;

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
  const { startTestDb } = await import(
    "../../../../../../common/db/e2e-db.container"
  );
  const testDb = await startTestDb();
  process.env.DATABASE_URL = testDb.url;
  for (const key of [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "POSTGRES_HOST",
  ]) {
    delete process.env[key];
  }
  console.log(`[github e2e] db mode: ${testDb.mode}`);

  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../../../../../../app/app.module");
  const { configureApp } = await import("../../../../../../app/app.setup");
  const { GithubAppService } = await import("../github-app.service");
  const { GithubInstallationsService } =
    await import("../github-installations.service");
  const { __setGithubFetchForTests } = await import("../github.service");
  const { signAppState } = await import("../utils/app-state");

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

  async function installStateFor(
    url: string,
    headers: Record<string, string>,
  ): Promise<string> {
    const res = await fetch(`${url}/api/v1/projects/github/install-url`, {
      headers,
    });
    assert.equal(res.status, 200);
    const body = (await readJson(res)) as { url?: string };
    const installUrl = typeof body.url === "string" ? body.url : "";
    const parsed = new URL(installUrl);
    assert.equal(
      `${parsed.origin}${parsed.pathname}`,
      "https://github.com/apps/rush-code-test-app/installations/new",
    );
    const state = parsed.searchParams.get("state");
    assert.ok(state, `expected a signed state in ${installUrl}`);
    return state;
  }

  // Bearer minting per phase (JWT sub = the caller's user key; installations
  // bind to the same string — C2 identity-only, no x-user-id / ?userId).
  async function bearerFor(
    app: unknown,
    sub: string,
  ): Promise<Record<string, string>> {
    const { TokenService } = await import("../../../../../../auth/token.service");
    const nest = app as { get: (t: unknown, o: unknown) => unknown };
    const tokens = nest.get(TokenService, { strict: false }) as {
      sign: (
        claims: Record<string, unknown>,
        secret: string,
        ttlSec: number,
      ) => { token: string };
    };
    const bearer = tokens.sign(
      { sub, email: `${sub}@rush-code.local`, typ: "access" },
      process.env.JWT_ACCESS_SECRET as string,
      900,
    ).token;
    return { authorization: `Bearer ${bearer}` };
  }

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
    const alice = await bearerFor(app, "alice");
    try {
      await check(
        "callback without PG → 503 EXTERNAL_UNAVAILABLE",
        async () => {
          const cid = "e2e-github-503-0001";
          const state = signAppState("alice", STATE_SECRET);
          const res = await fetch(
            `${base}/api/v1/projects/github/callback?installation_id=111&setup_action=install&state=${encodeURIComponent(state)}`,
            { headers: { "x-correlation-id": cid, ...alice } },
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

      await check("callback anon (no Bearer) → 401", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/callback?installation_id=111&setup_action=install`,
        );
        assert.equal(res.status, 401);
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
    const alice = await bearerFor(app, "alice");
    try {
      await check("GET repos w/o config → 401 (app unconfigured)", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/repos`, {
          headers: { ...alice },
        });
        assert.equal(res.status, 401);
        const body = (await readJson(res)) as { code?: string };
        assert.equal(body.code, "unauthorized");
      });

      await check("GET repos anon (no Bearer) → 401", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/repos`);
        assert.equal(res.status, 401);
      });

      await check("GET install-url w/o slug → 503", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/install-url`, {
          headers: { ...alice },
        });
        assert.equal(res.status, 503);
      });

      await check("POST webhook w/o secret → 503", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/webhook`,
          json({ action: "created" }),
        );
        assert.equal(res.status, 503);
      });

      await check("GET callback w/o app config → 401 (app unconfigured)", async () => {
        const state = signAppState("alice", STATE_SECRET);
        const res = await fetch(
          `${base}/api/v1/projects/github/callback?installation_id=999111&setup_action=install&state=${encodeURIComponent(state)}`,
          { headers: { ...alice } },
        );
        assert.equal(res.status, 401);
      });

      await check("GET callback bad installation_id → 400", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/callback?installation_id=nope`,
          { headers: { ...alice } },
        );
        assert.equal(res.status, 400);
      });

      await check("GET callback anon (no Bearer) → 401", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/callback?installation_id=111&setup_action=install`,
        );
        assert.equal(res.status, 401);
      });
    } finally {
      await app.close();
    }
  }

  // --- Phase B: multi-tenant, no legacy fallback -----------------------------
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-key-not-real-never-logged";
  process.env.GITHUB_APP_SLUG = "rush-code-test-app";
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
      getInstallation: (installationId: number) => Promise<{
        id: number;
        account: { login: string; type: string } | null;
        createdAt: string | null;
      }>;
    };
    appAuth.getInstallation = async (installationId: number) => ({
      id: installationId,
      account: {
        login: installationId === 333 ? "carol" : "alice",
        type: "User",
      },
      createdAt: new Date().toISOString(),
    });
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
    const alice = await bearerFor(app, "alice");
    const bob = await bearerFor(app, "bob");
    const carol = await bearerFor(app, "carol");
    try {
      await check("GET install-url → 200 with slug and signed state", async () => {
        const state = await installStateFor(base, alice);
        assert.ok(state.length > 0);
      });

      await check("callback without state → 400 (state is required)", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/callback?installation_id=111&setup_action=install`,
          { headers: { ...alice } },
        );
        assert.equal(res.status, 400);
        const body = (await readJson(res)) as { code?: string };
        assert.equal(body.code, "bad_request");
      });

      await check("callback binds alice → install 111", async () => {
        const state = await installStateFor(base, alice);
        const res = await fetch(
          `${base}/api/v1/projects/github/callback?installation_id=111&setup_action=install&state=${encodeURIComponent(state)}`,
          { headers: { ...alice } },
        );
        assert.equal(res.status, 200);
      });

      await check("GET repos alice → 200 normalized", async () => {
        const res = await fetch(
          `${base}/api/v1/projects/github/repos?page=1&per_page=2`,
          {
            headers: { ...alice },
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
        "GET repos ignores spoofed ?userId (Bearer alice wins) → 200",
        async () => {
          // Bob has no installation — if ?userId were honored this would
          // 404 GITHUB_NOT_INSTALLED. The Bearer identity always wins (C2).
          const res = await fetch(
            `${base}/api/v1/projects/github/repos?userId=bob`,
            { headers: { ...alice } },
          );
          assert.equal(res.status, 200);
        },
      );

      await check(
        "GET repos bob (no install) → 404 GITHUB_NOT_INSTALLED",
        async () => {
          const res = await fetch(`${base}/api/v1/projects/github/repos`, {
            headers: { ...bob },
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
            headers: { ...alice },
          },
        );
        assert.equal(res.status, 400);
      });

      await check("GET repos page=0 → 400", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/repos?page=0`, {
          headers: { ...alice },
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
          const state = await installStateFor(base, carol);
          const cb = await fetch(
            `${base}/api/v1/projects/github/callback?installation_id=333&setup_action=install&state=${encodeURIComponent(state)}`,
            { headers: { ...carol } },
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
            headers: { ...carol },
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
          headers: { ...carol },
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
          headers: { ...carol },
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
          headers: { ...carol },
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

  // --- Phase C: legacy single-install env id is ignored (fail-closed) --------
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
    const def = await bearerFor(app, "default");
    const stranger = await bearerFor(app, "stranger");
    try {
      await check("legacy fallback: default user without binding → 404", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/repos`, {
          headers: { ...def },
        });
        assert.equal(res.status, 404);
        const body = (await readJson(res)) as { code?: string };
        assert.equal(body.code, "GITHUB_NOT_INSTALLED");
      });

      await check("legacy fallback: other user still 404", async () => {
        const res = await fetch(`${base}/api/v1/projects/github/repos`, {
          headers: { ...stranger },
        });
        assert.equal(res.status, 404);
      });
    } finally {
      __setGithubFetchForTests(null);
      await app.close();
    }
  }
  delete process.env.GITHUB_APP_INSTALLATION_ID;

  await testDb.stop();
  console.log(`\ngithub e2e: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`github e2e failed to boot: ${(err as Error).message}`);
  process.exit(1);
});
