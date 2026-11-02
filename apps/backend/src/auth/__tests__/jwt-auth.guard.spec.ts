import "reflect-metadata";
import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import type { AppLogger } from "../../common/logger";
import type { DbService } from "../../common/db/db.service";
import type { UsersService } from "../../users/users.service";
import { JwtAuthGuard } from "../jwt-auth.guard";
import { TokenService } from "../token.service";

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

const USER_ID = "123e4567-e89b-12d3-a456-426614174001";
const EMAIL = "alice@example.com";
const ACCESS_SECRET = "unit-test-jwt-access-secret-0123456789";
const REFRESH_SECRET = "unit-test-jwt-refresh-secret-0123456789";

const APP_ENV_KEY =
  /^(APP_BACKEND_|OPENCODE_|POSTGRES_|DATABASE_URL$|CORS_|REQUEST_TIMEOUT_MS$|EXTERNAL_|LOG_LEVEL$|NEXT_PUBLIC_|GITHUB_|DOCKER_|NPM_|JWT_|AUTH_|REPOS_ROOT$|PROJECTS_ROOT$|CLONE_)/;

const BASE_ENV: Record<string, string> = {
  APP_BACKEND_PORT: "3000",
  APP_BACKEND_HOST: "127.0.0.1",
  APP_BACKEND_PROTOCOL: "http",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  CORS_ORIGINS: "http://localhost:3001",
  JWT_ACCESS_SECRET: ACCESS_SECRET,
  JWT_REFRESH_SECRET: REFRESH_SECRET,
  AUTH_LEGACY_MOCK_FALLBACK: "false",
};

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const saved: Array<[string, string | undefined]> = [];
  for (const key of Object.keys(process.env)) {
    if (APP_ENV_KEY.test(key)) saved.push([key, process.env[key]]);
  }
  for (const [key] of saved) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (APP_ENV_KEY.test(key)) delete process.env[key];
    }
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

function silentLogger(): AppLogger {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as AppLogger;
}

function makeTokens(): TokenService {
  return new TokenService({} as DbService, silentLogger());
}

type Lookup = { id: string; correlationId?: string };

function makeUsers(row: Record<string, unknown> | null = null): {
  users: UsersService;
  lookups: Array<Lookup>;
} {
  const lookups: Array<Lookup> = [];
  const users = {
    async findById(id: string, correlationId?: string) {
      lookups.push({ id, correlationId });
      return row;
    },
  } as unknown as UsersService;
  return { users, lookups };
}

function fakeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function request(
  headers: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { headers, correlationId: "cid-test", ...extra };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function isUnauthorized(err: unknown): boolean {
  assert.ok(
    err instanceof UnauthorizedException,
    `expected UnauthorizedException, got ${String(err)}`,
  );
  assert.equal(err.getStatus(), 401);
  const body = err.getResponse() as { code?: string; message?: string };
  assert.equal(body.code, "unauthorized");
  assert.equal(body.message, "Authentication required");
  return true;
}

function accessToken(tokens: TokenService, ttlSec = 900): string {
  return tokens.sign(
    { sub: USER_ID, email: EMAIL, typ: "access" },
    ACCESS_SECRET,
    ttlSec,
  ).token;
}

describe("JwtAuthGuard", () => {
  it("rejects a request without Authorization", async () => {
    await withEnv({}, async () => {
      const { users, lookups } = makeUsers();
      const guard = new JwtAuthGuard(makeTokens(), users, silentLogger());
      const req = request();
      await assert.rejects(async () => guard.canActivate(fakeContext(req)), isUnauthorized);
      assert.equal(req.user, undefined);
      assert.equal(lookups.length, 0);
    });
  });

  it("rejects a non-Bearer Authorization header", async () => {
    await withEnv({}, async () => {
      const { users } = makeUsers();
      const guard = new JwtAuthGuard(makeTokens(), users, silentLogger());
      await assert.rejects(
        async () => guard.canActivate(fakeContext(request({ authorization: "Basic abc" }))),
        isUnauthorized,
      );
    });
  });

  it("rejects a broken token", async () => {
    await withEnv({}, async () => {
      const { users, lookups } = makeUsers();
      const guard = new JwtAuthGuard(makeTokens(), users, silentLogger());
      await assert.rejects(
        async () => guard.canActivate(fakeContext(request(bearer("not-a-jwt")))),
        isUnauthorized,
      );
      assert.equal(lookups.length, 0);
    });
  });

  it("rejects an expired access token", async () => {
    await withEnv({}, async () => {
      const tokens = makeTokens();
      const { users } = makeUsers();
      const guard = new JwtAuthGuard(tokens, users, silentLogger());
      await assert.rejects(
        async () => guard.canActivate(fakeContext(request(bearer(accessToken(tokens, -5))))),
        isUnauthorized,
      );
    });
  });

  it("rejects refresh claims even with a valid signature", async () => {
    await withEnv({}, async () => {
      const tokens = makeTokens();
      const { users } = makeUsers();
      const guard = new JwtAuthGuard(tokens, users, silentLogger());
      const refresh = tokens.sign({ sub: USER_ID, typ: "refresh" }, ACCESS_SECRET, 900).token;
      await assert.rejects(
        async () => guard.canActivate(fakeContext(request(bearer(refresh)))),
        isUnauthorized,
      );
    });
  });

  it("rejects a token signed with the wrong access secret", async () => {
    await withEnv({}, async () => {
      const tokens = makeTokens();
      const { users } = makeUsers();
      const guard = new JwtAuthGuard(tokens, users, silentLogger());
      const forged = tokens.sign(
        { sub: USER_ID, email: EMAIL, typ: "access" },
        "another-access-secret-0123456789abcd",
        900,
      ).token;
      await assert.rejects(
        async () => guard.canActivate(fakeContext(request(bearer(forged)))),
        isUnauthorized,
      );
    });
  });

  it("accepts a valid access token and attaches the identity", async () => {
    await withEnv({}, async () => {
      const tokens = makeTokens();
      const { users, lookups } = makeUsers();
      const guard = new JwtAuthGuard(tokens, users, silentLogger());
      const req = request(bearer(accessToken(tokens)));

      assert.equal(await guard.canActivate(fakeContext(req)), true);
      assert.deepEqual(req.user, { id: USER_ID, email: EMAIL, mock: false });
      assert.equal(lookups.length, 0);
    });
  });

  it("accepts a lowercase bearer scheme", async () => {
    await withEnv({}, async () => {
      const tokens = makeTokens();
      const { users } = makeUsers();
      const guard = new JwtAuthGuard(tokens, users, silentLogger());
      const req = request({ authorization: `bearer ${accessToken(tokens)}` });
      assert.equal(await guard.canActivate(fakeContext(req)), true);
      assert.deepEqual(req.user, { id: USER_ID, email: EMAIL, mock: false });
    });
  });

  it("ignores x-user-id and ?userId when the legacy fallback is off", async () => {
    await withEnv({ AUTH_LEGACY_MOCK_FALLBACK: "false" }, async () => {
      const { users, lookups } = makeUsers();
      const guard = new JwtAuthGuard(makeTokens(), users, silentLogger());
      const withHeader = request({ "x-user-id": "mock-user" });
      const withQuery = request({}, { query: { userId: "mock-user" } });

      await assert.rejects(async () => guard.canActivate(fakeContext(withHeader)), isUnauthorized);
      await assert.rejects(async () => guard.canActivate(fakeContext(withQuery)), isUnauthorized);
      assert.equal(lookups.length, 0);
      assert.equal(withHeader.user, undefined);
      assert.equal(withQuery.user, undefined);
    });
  });

  it("attaches an unknown legacy mock identity when the fallback is on", async () => {
    await withEnv({ AUTH_LEGACY_MOCK_FALLBACK: "true" }, async () => {
      const { users, lookups } = makeUsers(null);
      const guard = new JwtAuthGuard(makeTokens(), users, silentLogger());
      const req = request({ "x-user-id": "mock-user" });

      assert.equal(await guard.canActivate(fakeContext(req)), true);
      assert.deepEqual(req.user, { id: "mock-user", email: null, mock: true });
      assert.deepEqual(lookups, [{ id: "mock-user", correlationId: "cid-test" }]);
    });
  });

  it("uses ?userId when the fallback is on and the header is absent", async () => {
    await withEnv({ AUTH_LEGACY_MOCK_FALLBACK: "true" }, async () => {
      const { users } = makeUsers(null);
      const guard = new JwtAuthGuard(makeTokens(), users, silentLogger());
      const req = request({}, { query: { userId: "query-user" } });

      assert.equal(await guard.canActivate(fakeContext(req)), true);
      assert.deepEqual(req.user, { id: "query-user", email: null, mock: true });
    });
  });

  it("uses the default mock user when the fallback is on and no id is supplied", async () => {
    await withEnv({ AUTH_LEGACY_MOCK_FALLBACK: "true" }, async () => {
      const { users } = makeUsers(null);
      const guard = new JwtAuthGuard(makeTokens(), users, silentLogger());
      const req = request();

      assert.equal(await guard.canActivate(fakeContext(req)), true);
      assert.deepEqual(req.user, { id: "default", email: null, mock: true });
    });
  });

  it("marks a known legacy identity as mock:false", async () => {
    await withEnv({ AUTH_LEGACY_MOCK_FALLBACK: "true" }, async () => {
      const { users } = makeUsers({ id: "known-user", email: "known@example.com" });
      const guard = new JwtAuthGuard(makeTokens(), users, silentLogger());
      const req = request({ "x-user-id": "known-user" });

      assert.equal(await guard.canActivate(fakeContext(req)), true);
      assert.deepEqual(req.user, { id: "known-user", email: "known@example.com", mock: false });
    });
  });

  it("prefers a valid bearer token over the legacy fallback", async () => {
    await withEnv({ AUTH_LEGACY_MOCK_FALLBACK: "true" }, async () => {
      const tokens = makeTokens();
      const { users, lookups } = makeUsers({ id: "mock-user", email: "mock@example.com" });
      const guard = new JwtAuthGuard(tokens, users, silentLogger());
      const req = request(
        { ...bearer(accessToken(tokens)), "x-user-id": "mock-user" },
      );

      assert.equal(await guard.canActivate(fakeContext(req)), true);
      assert.deepEqual(req.user, { id: USER_ID, email: EMAIL, mock: false });
      assert.equal(lookups.length, 0);
    });
  });

  it("answers 401 when the environment cannot be validated", async () => {
    await withEnv({ APP_BACKEND_PORT: "not-a-port" }, async () => {
      const tokens = makeTokens();
      const { users } = makeUsers();
      const guard = new JwtAuthGuard(tokens, users, silentLogger());
      await assert.rejects(
        async () => guard.canActivate(fakeContext(request(bearer(accessToken(tokens))))),
        (err: unknown) => {
          assert.ok(err instanceof UnauthorizedException);
          const body = err.getResponse() as { code?: string; message?: string };
          assert.equal(body.code, "unauthorized");
          assert.equal(body.message, "Authentication is not configured");
          return true;
        },
      );
    });
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
  console.log(`\n${cases.length - failed}/${cases.length} jwt auth guard checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`jwt auth guard checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
