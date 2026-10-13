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

type BillingMode = "ok" | "reject" | "ratelimit" | "badshape" | "hang";

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
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ balance: 42.5, usage: 7.25 }));
  });
  await new Promise<void>((resolve) => billing.listen(0, "127.0.0.1", resolve));
  const billingPort = (billing.address() as { port: number }).port;
  process.env.OPENCODE_BILLING_URL = `http://127.0.0.1:${billingPort}/usage`;

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

  // --- No-secret-in-logs capture (all AppLogger methods, whole suite) ------
  const { AppLogger } = await import("../common/app-logger.service.js");
  const captured: unknown[] = [];
  const methods = ["debug", "info", "warn", "error"] as const;
  const originals = methods.map((m) => AppLogger.prototype[m]);
  methods.forEach((m, i) => {
    (
      AppLogger.prototype as unknown as Record<string, (...a: unknown[]) => void>
    )[m] = function (...args: unknown[]) {
      captured.push(args);
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
          "SELECT encrypted_key, iv FROM user_opencode_keys",
        );
        assert.equal(rows.length, 1);
        const row = rows[0] as { encrypted_key: string; iv: string };
        assert.ok(!row.encrypted_key.includes(TEST_API_KEY));
        assert.ok(!row.iv.includes(TEST_API_KEY));
        const { CryptoService } = await import("./crypto.service.js");
        const svc = new CryptoService();
        assert.equal(
          svc.decrypt({ iv: row.iv, data: row.encrypted_key }),
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
      };
      assert.equal(body.balance, 42.5);
      assert.equal(body.usage, 7.25);
      assert.ok(body.updatedAt);
      assert.equal(body.apiKey, undefined);
      assert.equal(lastAuth, `Bearer ${TEST_API_KEY}`);
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
      const prev = process.env.OPENCODE_BILLING_URL;
      process.env.OPENCODE_BILLING_URL = "http://127.0.0.1:9/usage";
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
        process.env.OPENCODE_BILLING_URL = prev;
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
