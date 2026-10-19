/**
 * Opencode keys + usage e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist (tsc decorator metadata; do not run via
 * `bun test` on TS sources). Usage: `bun run build && bun dist/opencode-keys/opencode-keys.e2e.js`.
 *
 * Strict Postgres: needs a live PG (TEST_DATABASE_URL wins, DATABASE_URL
 * fallback; drizzle/0001..0005 applied automatically) — runs the full suite
 * against a programmable mock billing upstream (node:http on 127.0.0.1):
 * auth-only 401s, 400 validation, PUT/GET/DELETE key lifecycle, at-rest
 * ciphertext check (DB holds no plaintext), happy-path usage mapping +
 * upstream 401/429/bad-shape/unreachable mapping, and a no-secret-in-logs
 * scan over every captured AppLogger call. Never logs secrets.
 *
 * Without a reachable PG it asserts the outage surface instead: guarded
 * routes still answer 401 without a token (guard runs before the DB) and
 * register answers 503 EXTERNAL_UNAVAILABLE (Retry-After 30).
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Deterministic env — BEFORE AppModule import (ConfigModule.validate at create).
process.env.APP_BACKEND_PORT ??= "3000";
process.env.REQUEST_TIMEOUT_MS = "1500";
process.env.OPENCODE_URL = "http://127.0.0.1:9";
process.env.JWT_ACCESS_SECRET = "e2e-access-secret-not-real-0123456789";
process.env.JWT_REFRESH_SECRET = "e2e-refresh-secret-not-real-0123456789";
process.env.JWT_ACCESS_TTL = "15m";
process.env.JWT_REFRESH_TTL = "7d";
process.env.AUTH_LEGACY_MOCK_FALLBACK = "false";
process.env.OPENCODE_KEYS_ENCRYPTION_KEY =
  "e2e-opencode-keys-encryption-key-not-real-0123456789";

const TEST_API_KEY = "e2e-opencode-api-key-not-real-0123456789abcdef";

type BillingMode = "ok" | "breakdown" | "zen" | "reject" | "ratelimit" | "badshape" | "hang";

async function main(): Promise<void> {
  // --- Programmable mock billing upstream (per-user Bearer asserted) -------
  let mode: BillingMode = "ok";
  let lastAuth: string | null = null;
  const billing = createServer((req: IncomingMessage, res: ServerResponse) => {
    lastAuth =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : null;
    if (mode === "hang") return; // never responds → client timeout
    if (mode === "reject") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad key" }));
      return;
    }
    if (mode === "ratelimit") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "slow down" }));
      return;
    }
    if (mode === "badshape") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ nope: true }));
      return;
    }
    if (mode === "breakdown") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          balance: 42.5,
          usage: 7.25,
          daily: { used: 12.5, limit: 100 },
          weekly: { used: 60, limit: 100 },
          monthly: { used: 90, limit: 100 },
        }),
      );
      return;
    }
    if (mode === "zen") {
      // Real Zen Go shape: { usage: { rolling, weekly, monthly } } with
      // { status, percent, resetsAt } (see /v2/docs/console/go limits).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          usage: {
            rolling: { status: "ok", percent: 23.5, resetsAt: "2026-10-19T00:00:00.000Z" },
            weekly: { status: "ok", percent: 60, resetsAt: "2026-10-26T00:00:00.000Z" },
            monthly: { status: "rate-limited", percent: 92, resetsAt: "2026-11-01T00:00:00.000Z" },
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ balance: 42.5, usage: 7.25 }));
  });
  await new Promise<void>((resolve) => billing.listen(0, "127.0.0.1", resolve));
  const billingPort = (billing.address() as { port: number }).port;
  // Billing endpoint is a hard-coded module constant (no env override):
  // requests to it are rerouted to this mock via a fetchWithRetry shim
  // installed after the app boots (see below).
  let billingTarget = `http://127.0.0.1:${billingPort}/usage`;

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
  console.log(`[opencode-keys e2e] db mode: ${testDb.mode}`);

  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../app.module.js");
  const { configureApp } = await import("../app.setup.js");

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

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  if (testDb.mode === "live") {
    const { UsersService } = await import("../auth/users.service.js");
    const { TokenService } = await import("../auth/token.service.js");
    const users = app.get(UsersService, { strict: false }) as {
      clearAllForTests: () => Promise<void>;
    };
    const tokens = app.get(TokenService, { strict: false }) as {
      clearAllForTests: () => void;
    };
    await users.clearAllForTests();
    tokens.clearAllForTests();
  }
  await app.listen(0);
  const base = await app.getUrl();

  // Reroute the hard-coded billing constant to the mock above through the
  // live ExternalClient (keeps timeout/retry mapping identical to prod).
  const { OPENCODE_BILLING_URL, OpencodeBillingService } = await import(
    "./opencode-billing.service.js"
  );
  const billingSvc = app.get(OpencodeBillingService, { strict: false }) as unknown as {
    external: {
      fetchWithRetry: (
        url: string,
        init: RequestInit,
        opts: { service: string; operation: string; correlationId?: string },
      ) => Promise<Response>;
    };
  };
  const realFetchWithRetry = billingSvc.external.fetchWithRetry.bind(
    billingSvc.external,
  );
  billingSvc.external.fetchWithRetry = (url, init, opts) =>
    realFetchWithRetry(
      url === OPENCODE_BILLING_URL ? billingTarget : url,
      init,
      opts,
    );

  // --- No-secret-in-logs capture (all AppLogger methods, whole suite) ------
  // Captures { method, args } so the final scans can prove both never-log
  // secrets AND normal-path shape: warn/error are one-liners with
  // operation/status/code and no stack (`\n at ` only ever appears on debug).
  const { AppLogger } = await import("../common/app-logger.service.js");
  const captured: Array<{ method: string; args: unknown[] }> = [];
  const methods = ["debug", "info", "warn", "error"] as const;
  const originals = methods.map((m) => AppLogger.prototype[m]);
  methods.forEach((m, i) => {
    (
      AppLogger.prototype as unknown as Record<string, (...a: unknown[]) => void>
    )[m] = function (...args: unknown[]) {
      captured.push({ method: m, args });
      return (originals[i] as (...a: unknown[]) => unknown).apply(this, args);
    };
  });

  try {
    await check("PUT /key without token → 401 (fallback off)", async () => {
      const res = await fetch(
        `${base}/api/v1/key`,
        json({ apiKey: TEST_API_KEY }, "PUT"),
      );
      assert.equal(res.status, 401);
    });

    await check("GET /key without token → 401", async () => {
      const res = await fetch(`${base}/api/v1/key`);
      assert.equal(res.status, 401);
    });

    await check("DELETE /key without token → 401", async () => {
      const res = await fetch(`${base}/api/v1/key`, {
        method: "DELETE",
      });
      assert.equal(res.status, 401);
    });

    await check("GET /usage without token → 401", async () => {
      const res = await fetch(`${base}/api/v1/usage`);
      assert.equal(res.status, 401);
      const body = (await readJson(res)) as { code?: string };
      assert.equal(body.code, "unauthorized");
    });

    await check("garbage Bearer → 401", async () => {
      const res = await fetch(`${base}/api/v1/usage`, {
        headers: { authorization: "Bearer garbage" },
      });
      assert.equal(res.status, 401);
    });

    if (testDb.mode === "unreachable") {
      await check("POST register without PG → 503", async () => {
        const res = await fetch(
          `${base}/api/v1/auth/register`,
          json({
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@devbox.local",
            password: "s3cret-p4ss",
          }),
        );
        assert.equal(res.status, 503);
        assert.equal(res.headers.get("retry-after"), "30");
      });
      console.log(`\nopencode-keys e2e: ${passed}/${passed + failed} passed`);
      await new Promise((r) => setTimeout(r, 100));
      if (failed > 0) process.exitCode = 1;
      return;
    }

    // --- Live mode: full lifecycle --------------------------------------
    const email = `opencode-keys-${Date.now()}-${process.pid}@devbox.local`;
    let access = "";
    await check("register → 201 pair", async () => {
      const res = await fetch(
        `${base}/api/v1/auth/register`,
        json({
          firstName: "Ada",
          lastName: "Lovelace",
          email,
          password: "s3cret-p4ss",
        }),
      );
      assert.equal(res.status, 201);
      const body = (await readJson(res)) as { accessToken?: string };
      assert.ok(body.accessToken);
      access = body.accessToken as string;
    });
    const auth = () => ({ authorization: `Bearer ${access}` });

    await check("GET /usage with no key → 404 opencode_key_missing", async () => {
      const res = await fetch(`${base}/api/v1/usage`, {
        headers: auth(),
      });
      assert.equal(res.status, 404);
      const body = (await readJson(res)) as { code?: string };
      assert.equal(body.code, "opencode_key_missing");
    });

    await check("GET /key with no key → configured:false", async () => {
      const res = await fetch(`${base}/api/v1/key`, {
        headers: auth(),
      });
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as { configured?: boolean };
      assert.equal(body.configured, false);
    });

    await check("PUT /key short apiKey → 400", async () => {
      const res = await fetch(`${base}/api/v1/key`, {
        ...json({ apiKey: "short" }, "PUT"),
        headers: { "content-type": "application/json", ...auth() },
      });
      assert.equal(res.status, 400);
    });

    await check("PUT /key missing body → 400", async () => {
      const res = await fetch(`${base}/api/v1/key`, {
        ...json({}, "PUT"),
        headers: { "content-type": "application/json", ...auth() },
      });
      assert.equal(res.status, 400);
    });

    await check("PUT /key → 200 {ok,updatedAt}, no secret echo", async () => {
      const res = await fetch(`${base}/api/v1/key`, {
        ...json({ apiKey: TEST_API_KEY }, "PUT"),
        headers: { "content-type": "application/json", ...auth() },
      });
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as {
        ok?: boolean;
        updatedAt?: string;
        apiKey?: string;
      };
      assert.equal(body.ok, true);
      assert.ok(body.updatedAt);
      assert.equal(body.apiKey, undefined);
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes(TEST_API_KEY), "response echoes the key");
    });

    await check("at rest: DB holds ciphertext only (decrypt roundtrips)", async () => {
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: testDb.url,
        connectionTimeoutMillis: 5000,
      });
      try {
        const { rows } = await pool.query(
          "SELECT encrypted_key, iv, key_id FROM user_opencode_keys",
        );
        assert.equal(rows.length, 1);
        const row = rows[0] as { encrypted_key: string; iv: string; key_id: string };
        assert.ok(!row.encrypted_key.includes(TEST_API_KEY));
        assert.ok(!row.iv.includes(TEST_API_KEY));
        // KEK version envelope: fresh rows are wrapped with the active id.
        assert.equal(row.key_id, "v1");
        const { CryptoService } = await import("./crypto.service.js");
        const svc = new CryptoService();
        assert.equal(
          svc.decrypt({ keyId: row.key_id, iv: row.iv, data: row.encrypted_key }),
          TEST_API_KEY,
        );
      } finally {
        await pool.end().catch(() => undefined);
      }
    });

    await check("GET /key → configured:true + updatedAt", async () => {
      const res = await fetch(`${base}/api/v1/key`, {
        headers: auth(),
      });
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as {
        configured?: boolean;
        updatedAt?: string;
      };
      assert.equal(body.configured, true);
      assert.ok(body.updatedAt);
    });

    await check("GET /usage happy path → {balance,usage,updatedAt}", async () => {
      mode = "ok";
      lastAuth = null;
      const res = await fetch(`${base}/api/v1/usage`, {
        headers: auth(),
      });
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as {
        balance?: number;
        usage?: number;
        updatedAt?: string;
        apiKey?: string;
        daily?: unknown;
        weekly?: unknown;
        monthly?: unknown;
      };
      assert.equal(body.balance, 42.5);
      assert.equal(body.usage, 7.25);
      assert.ok(body.updatedAt);
      assert.equal(body.apiKey, undefined);
      assert.equal(lastAuth, `Bearer ${TEST_API_KEY}`);
      // Additive breakdown is optional: absent upstream → omitted, never derived.
      assert.equal(body.daily, undefined);
      assert.equal(body.weekly, undefined);
      assert.equal(body.monthly, undefined);
    });

    await check("GET /usage breakdown passthrough → daily/weekly/monthly", async () => {
      mode = "breakdown";
      const res = await fetch(`${base}/api/v1/usage`, {
        headers: auth(),
      });
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as {
        balance?: number;
        usage?: number;
        daily?: { used?: number; limit?: number };
        weekly?: { used?: number; limit?: number };
        monthly?: { used?: number; limit?: number };
      };
      assert.equal(body.balance, 42.5);
      assert.deepEqual(body.daily, { used: 12.5, limit: 100 });
      assert.deepEqual(body.weekly, { used: 60, limit: 100 });
      assert.deepEqual(body.monthly, { used: 90, limit: 100 });
      mode = "ok";
    });

    await check("billing URL is Zen Go (not the catch-all api.opencode.ai)", async () => {
      assert.equal(OPENCODE_BILLING_URL, "https://opencode.ai/zen/go/v1/usage");
    });

    await check("GET /usage Zen Go → rolling/weekly/monthly as used/limit 100", async () => {
      mode = "zen";
      const res = await fetch(`${base}/api/v1/usage`, {
        headers: auth(),
      });
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as {
        balance?: number;
        usage?: number;
        updatedAt?: string;
        rolling?: { used?: number; limit?: number };
        weekly?: { used?: number; limit?: number };
        monthly?: { used?: number; limit?: number };
      };
      // Zen payloads carry no balance/usage totals — buckets only, never faked.
      assert.equal(body.balance, undefined);
      assert.equal(body.usage, undefined);
      assert.ok(body.updatedAt);
      assert.deepEqual(body.rolling, { used: 23.5, limit: 100 });
      assert.deepEqual(body.weekly, { used: 60, limit: 100 });
      assert.deepEqual(body.monthly, { used: 92, limit: 100 });
      mode = "ok";
    });

    await check("legacy row without keyId stays readable + lazily re-encrypts", async () => {
      mode = "ok";
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: testDb.url,
        connectionTimeoutMillis: 5000,
      });
      try {
        // Simulate a pre-versioning row (no KEK id): dual-read fallback
        // must still open it, then converge it to the active KEK id.
        await pool.query("UPDATE user_opencode_keys SET key_id = ''");
        const usage = await fetch(`${base}/api/v1/usage`, { headers: auth() });
        assert.equal(usage.status, 200);
        const { rows } = await pool.query(
          "SELECT encrypted_key, iv, key_id FROM user_opencode_keys",
        );
        const row = rows[0] as { encrypted_key: string; iv: string; key_id: string };
        assert.equal(row.key_id, "v1");
        const { CryptoService } = await import("./crypto.service.js");
        const svc = new CryptoService();
        assert.equal(
          svc.decrypt({ keyId: row.key_id, iv: row.iv, data: row.encrypted_key }),
          TEST_API_KEY,
        );
      } finally {
        await pool.end().catch(() => undefined);
      }
    });

    await check("rotation: previous KEK decrypts, lazy re-encrypt converges", async () => {
      mode = "ok";
      lastAuth = null;
      const prevKey = process.env.OPENCODE_KEYS_ENCRYPTION_KEY as string;
      const NEW_KEY = "e2e-opencode-keys-rotation-key-not-real-0123456789abcd";
      process.env.OPENCODE_KEYS_ENCRYPTION_KEY = NEW_KEY;
      process.env.OPENCODE_KEYS_ACTIVE_KEY_ID = "v2";
      process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS = prevKey;
      process.env.OPENCODE_KEYS_PREVIOUS_KEY_ID = "v1";
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: testDb.url,
        connectionTimeoutMillis: 5000,
      });
      try {
        // Old row (keyId v1) opens via the previous KEK, then re-wraps to v2.
        const usage = await fetch(`${base}/api/v1/usage`, { headers: auth() });
        assert.equal(usage.status, 200);
        assert.equal(lastAuth, `Bearer ${TEST_API_KEY}`);
        const { rows } = await pool.query(
          "SELECT encrypted_key, iv, key_id FROM user_opencode_keys",
        );
        const row = rows[0] as { encrypted_key: string; iv: string; key_id: string };
        assert.equal(row.key_id, "v2");
        assert.ok(!row.encrypted_key.includes(TEST_API_KEY));
      } finally {
        await pool.end().catch(() => undefined);
        // Restore the suite KEK and re-wrap the row under it so the
        // remaining error-mapping checks keep decrypting.
        process.env.OPENCODE_KEYS_ENCRYPTION_KEY = prevKey;
        process.env.OPENCODE_KEYS_ACTIVE_KEY_ID = "v1";
        delete process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS;
        process.env.OPENCODE_KEYS_PREVIOUS_KEY_ID = "v0";
        const put = await fetch(`${base}/api/v1/key`, {
          ...json({ apiKey: TEST_API_KEY }, "PUT"),
          headers: { "content-type": "application/json", ...auth() },
        });
        assert.equal(put.status, 200);
      }
    });

    await check("upstream 401 → 401 opencode_key_invalid (no echo)", async () => {
      mode = "reject";
      const res = await fetch(`${base}/api/v1/usage`, {
        headers: auth(),
      });
      assert.equal(res.status, 401);
      const body = (await readJson(res)) as { code?: string };
      assert.equal(body.code, "opencode_key_invalid");
      assert.ok(!JSON.stringify(body).includes(TEST_API_KEY));
    });

    await check("upstream 429 → 429 EXTERNAL_RATE_LIMITED", async () => {
      mode = "ratelimit";
      const res = await fetch(`${base}/api/v1/usage`, {
        headers: auth(),
      });
      assert.equal(res.status, 429);
      const body = (await readJson(res)) as { code?: string };
      assert.equal(body.code, "EXTERNAL_RATE_LIMITED");
    });

    await check("upstream bad shape → 503 EXTERNAL_UNAVAILABLE", async () => {
      mode = "badshape";
      const res = await fetch(`${base}/api/v1/usage`, {
        headers: auth(),
      });
      assert.equal(res.status, 503);
      const body = (await readJson(res)) as { code?: string };
      assert.equal(body.code, "EXTERNAL_UNAVAILABLE");
      assert.equal(res.headers.get("retry-after"), "30");
    });

    await check("upstream hang → 504 EXTERNAL_TIMEOUT", async () => {
      mode = "hang";
      const res = await fetch(`${base}/api/v1/usage`, {
        headers: auth(),
      });
      assert.equal(res.status, 504);
      const body = (await readJson(res)) as { code?: string };
      assert.equal(body.code, "EXTERNAL_TIMEOUT");
    });

    await check("upstream unreachable → 503 (no secret echo)", async () => {
      const prev = billingTarget;
      billingTarget = "http://127.0.0.1:9/usage";
      try {
        const res = await fetch(`${base}/api/v1/usage`, {
          headers: auth(),
        });
        assert.ok(
          res.status === 503 || res.status === 504,
          `expected 503/504, got ${res.status}`,
        );
        const body = (await readJson(res)) as { code?: string };
        assert.ok(
          body.code === "EXTERNAL_UNAVAILABLE" || body.code === "EXTERNAL_TIMEOUT",
          `unexpected code ${body.code}`,
        );
        assert.ok(!JSON.stringify(body).includes(TEST_API_KEY));
      } finally {
        billingTarget = prev;
      }
    });

    await check("DELETE /key → ok; status flips; usage 404 again", async () => {
      const del = await fetch(`${base}/api/v1/key`, {
        method: "DELETE",
        headers: auth(),
      });
      assert.equal(del.status, 200);
      assert.equal(((await readJson(del)) as { ok?: boolean }).ok, true);
      const status = (await readJson(
        await fetch(`${base}/api/v1/key`, { headers: auth() }),
      )) as { configured?: boolean };
      assert.equal(status.configured, false);
      const usage = await fetch(`${base}/api/v1/usage`, {
        headers: auth(),
      });
      assert.equal(usage.status, 404);
    });

    await check("no secret in any captured log call", async () => {
      const dump = JSON.stringify(captured);
      assert.ok(!dump.includes(TEST_API_KEY), "API key reached the logs");
      assert.ok(
        !dump.includes(process.env.OPENCODE_KEYS_ENCRYPTION_KEY as string),
        "encryption secret reached the logs",
      );
      // Never-log Bearer/URL/body: fixed messages only — no auth header
      // value and no upstream URL ever reach AppLogger on this path.
      assert.ok(!dump.includes("Bearer "), "Bearer value reached the logs");
      assert.ok(
        !dump.toLowerCase().includes("opencode.ai/zen/go"),
        "upstream URL reached the logs",
      );
    });

    await check("normal-path warn/error are one-liners with context, no stack", async () => {
      const normal = captured.filter((e) => e.method === "warn" || e.method === "error");
      assert.ok(normal.length > 0, "expected warn/error lines from the error-mapping checks");
      for (const entry of normal) {
        const text = JSON.stringify(entry.args);
        // Stacks always contain a newline (JSON-escaped as `\\n`) + an `at`
        // frame; normal-path warn/error must stay single-line (stack lives
        // on debug only). Fixed phrases like `unreachable at startup` are
        // fine — only the escaped newline proves a stack leaked.
        assert.ok(!text.includes("\\n"), `stack/newline in ${entry.method}: ${text.slice(0, 300)}`);
      }
      const warnErrorText = normal.map((e) => JSON.stringify(e.args)).join("\n");
      // Billing context: operation + status + code on rejected/shape/bad-json lines.
      assert.ok(warnErrorText.includes("getUsage"), "missing billing operation context");
      assert.ok(warnErrorText.includes("status="), "missing status context");
      assert.ok(warnErrorText.includes("code="), "missing code context");
      // Http filter context: handled line with status/code.
      assert.ok(warnErrorText.includes("[http] handled"), "missing filter handled line");
      // Transport context: external retry/failure lines.
      const allText = JSON.stringify(captured);
      assert.ok(allText.includes("[external]"), "missing external transport lines");
    });
  } finally {
    methods.forEach((m, i) => {
      (
        AppLogger.prototype as unknown as Record<string, (...a: unknown[]) => void>
      )[m] = originals[i] as (...a: unknown[]) => void;
    });
    await app.close();
    billing.close();
  }

  console.log(`\nopencode-keys e2e: ${passed}/${passed + failed} passed`);
  await new Promise((r) => setTimeout(r, 100));
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`opencode-keys e2e failed to boot: ${(err as Error).message}`);
  process.exitCode = 1;
});
