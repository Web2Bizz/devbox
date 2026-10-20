/**
 * Auth (internal accounts) e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist (tsc decorator metadata; do not run via
 * `bun test` on TS sources). Usage: `bun run build && bun dist/auth/auth.e2e.js`.
 *
 * Strict Postgres: needs a live PG (TEST_DATABASE_URL wins, DATABASE_URL
 * fallback; drizzle/0003 applied automatically) — runs the full suite.
 * Without a reachable PG it asserts the outage surface instead: register /
 * login answer 503 EXTERNAL_UNAVAILABLE (Retry-After 30, envelope
 * { code, message, correlationId }) and /health reports db:down.
 * Never logs secrets.
 */
import assert from "node:assert/strict";

// Deterministic env — BEFORE AppModule import (ConfigModule.validate at create).
// NOTE: DATABASE_URL is resolved inside main() (TEST_DATABASE_URL seam) —
process.env.APP_BACKEND_PORT ??= "3000";
process.env.REQUEST_TIMEOUT_MS = "2000";
process.env.OPENCODE_URL = "http://127.0.0.1:9";
process.env.JWT_ACCESS_SECRET = "e2e-access-secret-not-real-0123456789";
process.env.JWT_REFRESH_SECRET = "e2e-refresh-secret-not-real-0123456789";
process.env.JWT_ACCESS_TTL = "15m";
process.env.JWT_REFRESH_TTL = "7d";
process.env.AUTH_LEGACY_MOCK_FALLBACK = "false";

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
  console.log(`[auth e2e] db mode: ${testDb.mode}`);

  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../app.module");
  const { configureApp } = await import("../app.setup");
  const { UsersService } = await import("./users.service");
  const { TokenService } = await import("./token.service");

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

  if (testDb.mode === "unreachable") {
    // No live PG — assert the strict outage surface (no memory fallback).
    try {
      await check(
        "POST register without PG → 503 EXTERNAL_UNAVAILABLE",
        async () => {
          const cid = "e2e-auth-503-0001";
          const res = await fetch(`${base}/api/v1/auth/register`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-correlation-id": cid,
            },
            body: JSON.stringify({
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@devbox.local",
              password: "s3cret-p4ss",
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

      await check("POST login without PG → 503", async () => {
        const res = await fetch(
          `${base}/api/v1/auth/login`,
          json({ email: "ada@devbox.local", password: "s3cret-p4ss" }),
        );
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
    } finally {
      await app.close();
    }

    console.log(`\nauth e2e: ${passed}/${passed + failed} passed`);
    // Flush stdout before exiting (piped capture loses racing process.exit).
    await new Promise((r) => setTimeout(r, 100));
    if (failed > 0) process.exitCode = 1;
    return;
  }

  let access = "";
  let refresh = "";
  try {
    await check("POST register → 201 pair", async () => {
      const res = await fetch(
        `${base}/api/v1/auth/register`,
        json({
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@devbox.local",
          password: "s3cret-p4ss",
        }),
      );
      assert.equal(res.status, 201);
      const body = (await readJson(res)) as {
        user?: { id?: string; email?: string };
        accessToken?: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
      };
      assert.ok(body.user?.id);
      assert.equal(body.user?.email, "ada@devbox.local");
      assert.ok(body.accessToken);
      assert.ok(body.refreshToken);
      assert.equal(body.tokenType, "bearer");
      assert.equal(body.expiresIn, 900);
      assert.match(res.headers.get("set-cookie") ?? "", /devbox-refresh/);
      access = body.accessToken as string;
      refresh = body.refreshToken as string;
    });

    await check("POST register duplicate → 409 email_taken", async () => {
      const res = await fetch(
        `${base}/api/v1/auth/register`,
        json({
          firstName: "Ada",
          lastName: "Other",
          email: "ADA@devbox.local",
          password: "s3cret-p4ss",
        }),
      );
      assert.equal(res.status, 409);
      const body = (await readJson(res)) as { code?: string };
      assert.equal(body.code, "email_taken");
    });

    await check(
      "POST register duplicate carries correlationId (header == body)",
      async () => {
        const cid = "e2e-corr-id-0001";
        const res = await fetch(`${base}/api/v1/auth/register`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-correlation-id": cid,
          },
          body: JSON.stringify({
            firstName: "Ada",
            lastName: "Other",
            email: "ada@devbox.local",
            password: "s3cret-p4ss",
          }),
        });
        assert.equal(res.status, 409);
        const body = (await readJson(res)) as {
          code?: string;
          correlationId?: string;
        };
        assert.equal(body.code, "email_taken");
        assert.equal(body.correlationId, cid);
        assert.equal(res.headers.get("x-correlation-id"), cid);
      },
    );

    await check(
      "register duplicate logs warn with correlationId (no secrets)",
      async () => {
        const { AppLogger } = await import("../common/app-logger.service");
        const seen: Array<{ msg: unknown; cid?: string }> = [];
        const origWarn = AppLogger.prototype.warn;
        (
          AppLogger.prototype as unknown as {
            warn: (msg: unknown, cid?: string) => void;
          }
        ).warn = function (msg: unknown, cid?: string) {
          seen.push({ msg, cid });
          return origWarn.call(this, msg, cid);
        };
        try {
          const cid = "e2e-corr-id-0002";
          await fetch(`${base}/api/v1/auth/register`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-correlation-id": cid,
            },
            body: JSON.stringify({
              firstName: "Ada",
              lastName: "Other",
              email: "ada@devbox.local",
              password: "s3cret-p4ss",
            }),
          });
        } finally {
          AppLogger.prototype.warn = origWarn;
        }
        const hit = seen.find(
          (s) => typeof s.msg === "string" && s.msg.includes("email_taken"),
        );
        assert.ok(hit, "expected warn with email_taken");
        assert.equal(hit?.cid, "e2e-corr-id-0002");
        assert.ok(
          !JSON.stringify(seen).includes("s3cret-p4ss"),
          "logs must not carry passwords",
        );
      },
    );

    await check("POST register bad email → 400", async () => {
      const res = await fetch(
        `${base}/api/v1/auth/register`,
        json({
          firstName: "A",
          lastName: "B",
          email: "not-an-email",
          password: "s3cret-p4ss",
        }),
      );
      assert.equal(res.status, 400);
    });

    await check("POST register short password → 400", async () => {
      const res = await fetch(
        `${base}/api/v1/auth/register`,
        json({
          firstName: "A",
          lastName: "B",
          email: "a@b.co",
          password: "short",
        }),
      );
      assert.equal(res.status, 400);
    });

    await check("POST login → 200 pair", async () => {
      const res = await fetch(
        `${base}/api/v1/auth/login`,
        json({ email: "ada@devbox.local", password: "s3cret-p4ss" }),
      );
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as {
        accessToken?: string;
        refreshToken?: string;
      };
      assert.ok(body.accessToken);
      assert.ok(body.refreshToken);
      access = body.accessToken as string;
      refresh = body.refreshToken as string;
    });

    await check(
      "POST login wrong password → 401 invalid_credentials",
      async () => {
        const res = await fetch(
          `${base}/api/v1/auth/login`,
          json({ email: "ada@devbox.local", password: "wrong-pass-1" }),
        );
        assert.equal(res.status, 401);
        const body = (await readJson(res)) as { code?: string };
        assert.equal(body.code, "invalid_credentials");
      },
    );

    await check(
      "POST login unknown email → 401 invalid_credentials (no enumeration)",
      async () => {
        const res = await fetch(
          `${base}/api/v1/auth/login`,
          json({ email: "nobody@devbox.local", password: "s3cret-p4ss" }),
        );
        assert.equal(res.status, 401);
        const body = (await readJson(res)) as { code?: string };
        assert.equal(body.code, "invalid_credentials");
      },
    );

    await check("GET me with Bearer → 200", async () => {
      const res = await fetch(`${base}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${access}` },
      });
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as {
        email?: string;
        firstName?: string;
      };
      assert.equal(body.email, "ada@devbox.local");
      assert.equal(body.firstName, "Ada");
    });

    await check("GET me without token → 401 (fallback off)", async () => {
      const res = await fetch(`${base}/api/v1/auth/me`);
      assert.equal(res.status, 401);
    });

    await check("PATCH me → 200 updated", async () => {
      const res = await fetch(`${base}/api/v1/auth/me`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${access}`,
        },
        body: JSON.stringify({ firstName: "Augusta" }),
      });
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as { firstName?: string };
      assert.equal(body.firstName, "Augusta");
    });

    await check("POST refresh rotation → 200 new pair", async () => {
      const res = await fetch(
        `${base}/api/v1/auth/refresh`,
        json({ refreshToken: refresh }),
      );
      assert.equal(res.status, 200);
      const body = (await readJson(res)) as {
        accessToken?: string;
        refreshToken?: string;
      };
      assert.ok(body.accessToken);
      assert.ok(body.refreshToken);
      access = body.accessToken as string;
      refresh = body.refreshToken as string;
    });

    await check("POST refresh reuse of rotated token → 401", async () => {
      // `refresh` var already rotated; reuse the previous one is impossible —
      // login once more to get a fresh token, rotate it, then replay it.
      const login = (await readJson(
        await fetch(
          `${base}/api/v1/auth/login`,
          json({ email: "ada@devbox.local", password: "s3cret-p4ss" }),
        ),
      )) as { refreshToken?: string };
      const first = login.refreshToken as string;
      const rotated = (await readJson(
        await fetch(
          `${base}/api/v1/auth/refresh`,
          json({ refreshToken: first }),
        ),
      )) as { refreshToken?: string };
      assert.ok(rotated.refreshToken);
      const replay = await fetch(
        `${base}/api/v1/auth/refresh`,
        json({ refreshToken: first }),
      );
      assert.equal(replay.status, 401);
      refresh = rotated.refreshToken as string;
    });

    await check("POST refresh garbage → 401", async () => {
      const res = await fetch(
        `${base}/api/v1/auth/refresh`,
        json({ refreshToken: "garbage" }),
      );
      assert.equal(res.status, 401);
    });

    await check("POST logout → 200, refresh after logout → 401", async () => {
      const out = await fetch(
        `${base}/api/v1/auth/logout`,
        json({ refreshToken: refresh }),
      );
      assert.equal(out.status, 200);
      const again = await fetch(
        `${base}/api/v1/auth/refresh`,
        json({ refreshToken: refresh }),
      );
      assert.equal(again.status, 401);
    });

    await check("fallback off: github repos w/o token → 401", async () => {
      const res = await fetch(`${base}/api/v1/projects/github/repos`, {
        headers: { "x-user-id": "alice" },
      });
      // GitHub App unconfigured in this env → 401 either way (auth surface intact).
      assert.equal(res.status, 401);
    });
  } finally {
    await app.close();
  }

  // --- Dual-mode: legacy fallback ON → mock identity accepted --------------
  process.env.AUTH_LEGACY_MOCK_FALLBACK = "true";
  {
    const { NestFactory: NF2 } = await import("@nestjs/core");
    const app2 = await NF2.create(AppModule, { logger: false });
    configureApp(app2);
    await app2.listen(0);
    const base2 = await app2.getUrl();
    try {
      await check(
        "fallback on: github repos mock user → 401 unconfigured (not crash)",
        async () => {
          const res = await fetch(`${base2}/api/v1/projects/github/repos`, {
            headers: { "x-user-id": "alice" },
          });
          assert.equal(res.status, 401);
        },
      );
    } finally {
      await app2.close();
    }
  }
  delete process.env.AUTH_LEGACY_MOCK_FALLBACK;

  console.log(`\nauth e2e: ${passed}/${passed + failed} passed`);
  // Flush stdout before exiting (piped capture loses racing process.exit).
  await new Promise((r) => setTimeout(r, 100));
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`auth e2e failed to boot: ${(err as Error).message}`);
  process.exitCode = 1;
});
