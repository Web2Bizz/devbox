import assert from "node:assert/strict";
import type { Response } from "express";
import { validateEnv } from "../../common/env/env";
import type { AppLogger } from "../../common/logger";
import type { StoredUser } from "../../users/users.types";
import { AUTH_MARKER_COOKIE, AuthController, REFRESH_COOKIE } from "../auth.controller";
import type { LocalAuthProvider } from "../auth-provider";
import type { LoginInput } from "../auth.dto";
import type { TokenService } from "../token.service";
import type { UsersService } from "../../users/users.service";
import type { OrganizationsService } from "../../organizations/organizations.service";

type Case = { name: string; run: () => Promise<void> | void };

const cases: Array<Case> = [];
let currentSuite = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

type CookieCall = { name: string; value: string; options: Record<string, unknown> };

function storedUser(): StoredUser {
  return {
    id: "user-1",
    firstName: "Alice",
    lastName: "Example",
    email: "alice@example.com",
    provider: "local",
    createdAt: "2025-01-01T00:00:00.000Z",
    passwordHash: "argon2-hash-not-real",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

function authHarness() {
  const cookieCalls: Array<CookieCall> = [];
  const res = {
    cookie(name: string, value: string, options?: Record<string, unknown>) {
      cookieCalls.push({ name, value, options: options ?? {} });
    },
  } as unknown as Response;
  const users = {} as unknown as UsersService;
  const tokens = {
    async issuePair() {
      return {
        accessToken: "access-token-not-real",
        refreshToken: "refresh-token-not-real",
        expiresIn: 900,
      };
    },
  } as unknown as TokenService;
  const local = {
    async verify() {
      return storedUser();
    },
  } as unknown as LocalAuthProvider;
  const organizations = {
    async create() {
      return { id: "org-id" };
    },
  } as unknown as OrganizationsService;
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    withCorrelationId() {
      return this;
    },
  } as unknown as AppLogger;
  const ctl = new AuthController(users, tokens, local, organizations, logger);
  return { ctl, res, cookieCalls };
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baseEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    APP_BACKEND_PORT: "3000",
    APP_BACKEND_HOST: "127.0.0.1",
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    CORS_ORIGINS: "http://localhost:3001",
    JWT_ACCESS_SECRET: "test-jwt-access-secret-not-real-0123456789",
    JWT_REFRESH_SECRET: "test-jwt-refresh-secret-not-real-0123456789",
    ...over,
  } as NodeJS.ProcessEnv;
}

const LOGIN: LoginInput = {
  email: "alice@example.com",
  password: "password-not-real",
};

async function sessionCookies(
  sameSite: string | undefined,
): Promise<Array<CookieCall>> {
  return await withEnv(
    {
      AUTH_COOKIE_SAMESITE: sameSite,
      NODE_ENV: "test",
      APP_BACKEND_PORT: "3000",
    },
    async () => {
      const { ctl, res, cookieCalls } = authHarness();
      await ctl.login(LOGIN, res);
      return cookieCalls;
    },
  );
}

function cookie(calls: Array<CookieCall>, name: string): CookieCall {
  const found = calls.find((call) => call.name === name);
  assert.ok(found, `expected a ${name} cookie, got ${JSON.stringify(calls.map((c) => c.name))}`);
  return found;
}

describe("AuthController session cookie sameSite", () => {
  it("uses sameSite=none with secure=true for both cookies when AUTH_COOKIE_SAMESITE=none", async () => {
    const calls = await sessionCookies("none");
    const refresh = cookie(calls, REFRESH_COOKIE);
    const marker = cookie(calls, AUTH_MARKER_COOKIE);
    assert.equal(refresh.options.sameSite, "none");
    assert.equal(refresh.options.secure, true);
    assert.equal(marker.options.sameSite, "none");
    assert.equal(marker.options.secure, true);
  });

  it("uses sameSite=strict when AUTH_COOKIE_SAMESITE=strict", async () => {
    const calls = await sessionCookies("strict");
    assert.equal(cookie(calls, REFRESH_COOKIE).options.sameSite, "strict");
    assert.equal(cookie(calls, AUTH_MARKER_COOKIE).options.sameSite, "strict");
  });

  it("defaults to sameSite=lax when AUTH_COOKIE_SAMESITE is unset", async () => {
    const calls = await sessionCookies(undefined);
    assert.equal(cookie(calls, REFRESH_COOKIE).options.sameSite, "lax");
    assert.equal(cookie(calls, AUTH_MARKER_COOKIE).options.sameSite, "lax");
  });

  it("rejects an unknown AUTH_COOKIE_SAMESITE at env validation", () => {
    assert.throws(
      () => validateEnv(baseEnv({ AUTH_COOKIE_SAMESITE: "weird" })),
      /\[env\] AUTH_COOKIE_SAMESITE/,
    );
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`auth sameSite checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
