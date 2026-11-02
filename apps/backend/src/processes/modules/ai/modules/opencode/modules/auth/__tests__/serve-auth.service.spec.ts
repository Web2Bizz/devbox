import assert from "node:assert/strict";
import { serveBasicAuthHeader } from "../serve-auth.service";

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

const APP_ENV_KEY =
  /^(APP_BACKEND_|OPENCODE_|POSTGRES_|DATABASE_URL$|CORS_|REQUEST_TIMEOUT_MS$|EXTERNAL_|LOG_LEVEL$|NEXT_PUBLIC_|GITHUB_|DOCKER_|NPM_|JWT_|AUTH_|REPOS_ROOT$|PROJECTS_ROOT$|CLONE_)/;

const BASE_ENV: Record<string, string> = {
  APP_BACKEND_PORT: "3000",
  APP_BACKEND_HOST: "127.0.0.1",
  APP_BACKEND_PROTOCOL: "http",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  CORS_ORIGINS: "http://localhost:3001",
  JWT_ACCESS_SECRET: "unit-test-jwt-access-secret-0123456789",
  JWT_REFRESH_SECRET: "unit-test-jwt-refresh-secret-0123456789",
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

function basicOf(value: string): string {
  return `Basic ${Buffer.from(value, "utf8").toString("base64")}`;
}

function decode(header: string): string {
  assert.match(header, /^Basic /);
  return Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
}

describe("serveBasicAuthHeader", () => {
  it("builds Basic base64(opencode:<OPENCODE_PASSWORD>)", async () => {
    await withEnv({ OPENCODE_PASSWORD: "unit-test-password-not-real" }, () => {
      const headers = serveBasicAuthHeader();
      assert.deepEqual(headers, {
        authorization: basicOf("opencode:unit-test-password-not-real"),
      });
      assert.deepEqual(Object.keys(headers), ["authorization"]);
      assert.equal(decode(headers.authorization ?? ""), "opencode:unit-test-password-not-real");
    });
  });

  it("falls back to OPENCODE_SERVER_PASSWORD when OPENCODE_PASSWORD is unset", async () => {
    await withEnv(
      {
        OPENCODE_PASSWORD: undefined,
        OPENCODE_SERVER_PASSWORD: "server-side-password-not-real",
      },
      () => {
        assert.deepEqual(serveBasicAuthHeader(), {
          authorization: basicOf("opencode:server-side-password-not-real"),
        });
      },
    );
  });

  it("prefers OPENCODE_PASSWORD over OPENCODE_SERVER_PASSWORD", async () => {
    await withEnv(
      {
        OPENCODE_PASSWORD: "client-side-password-not-real",
        OPENCODE_SERVER_PASSWORD: "server-side-password-not-real",
      },
      () => {
        assert.equal(
          decode(serveBasicAuthHeader().authorization ?? ""),
          "opencode:client-side-password-not-real",
        );
      },
    );
  });

  it("returns an empty object when no password is configured", async () => {
    await withEnv(
      { OPENCODE_PASSWORD: undefined, OPENCODE_SERVER_PASSWORD: undefined },
      () => {
        assert.deepEqual(serveBasicAuthHeader(), {});
      },
    );
  });

  it("returns an empty object for an empty or whitespace-only password", async () => {
    await withEnv({ OPENCODE_PASSWORD: "", OPENCODE_SERVER_PASSWORD: undefined }, () => {
      assert.deepEqual(serveBasicAuthHeader(), {});
    });
    await withEnv({ OPENCODE_PASSWORD: "   ", OPENCODE_SERVER_PASSWORD: undefined }, () => {
      assert.deepEqual(serveBasicAuthHeader(), {});
    });
  });

  it("encodes a unicode password as UTF-8", async () => {
    const password = "pässwörd-юникод-密码";
    await withEnv({ OPENCODE_PASSWORD: password }, () => {
      const header = serveBasicAuthHeader().authorization ?? "";
      assert.equal(header, basicOf(`opencode:${password}`));
      assert.equal(decode(header), `opencode:${password}`);
    });
  });

  it("returns an empty object when the environment is unreadable", async () => {
    await withEnv({ APP_BACKEND_PORT: "not-a-port", OPENCODE_PASSWORD: "irrelevant" }, () => {
      assert.deepEqual(serveBasicAuthHeader(), {});
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
  console.log(`\n${cases.length - failed}/${cases.length} serve auth checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`serve auth checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
