import assert from "node:assert/strict";
import { validateEnv } from "../../../../../../common/env/env";
import type { GithubAppService } from "../github-app.service";
import type { GithubInstallation } from "../github-installations.service";
import type { ListReposQueryInput } from "../github.dto";
import { GithubService, __setGithubFetchForTests } from "../github.service";

process.env.APP_BACKEND_PORT ??= "3000";
process.env.EXTERNAL_RETRY_MAX_ATTEMPTS = "1";
process.env.EXTERNAL_RETRY_BASE_DELAY_MS = "0";
process.env.EXTERNAL_RETRY_MAX_DELAY_MS = "0";

type Case = { name: string; run: () => Promise<void> | void };

const cases: Case[] = [];
let currentSuite = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
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

function installation(): GithubInstallation {
  return {
    userId: "alice",
    installationId: 111,
    accountLogin: "acme",
    accountType: "Organization",
    suspendedAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

type ServiceCtor = new (
  appAuth: unknown,
  logger: unknown,
  installations: unknown,
) => GithubService;

function service(): GithubService {
  const appAuth = {
    async getInstallationToken(): Promise<string> {
      return "ghs_test_token_not_real";
    },
  } as unknown as GithubAppService;
  const loggerAndInstallations = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    async findByInstallationId(): Promise<GithubInstallation | null> {
      return installation();
    },
  };
  const Ctor = GithubService as unknown as ServiceCtor;
  return new Ctor(appAuth, loggerAndInstallations, loggerAndInstallations);
}

type FetchInit = { signal?: AbortSignal | null };

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function hangingFetch(signals: Array<AbortSignal | null | undefined>): typeof fetch {
  return (async (_input: unknown, init?: FetchInit): Promise<Response> => {
    const signal = init?.signal ?? null;
    signals.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      if (!signal) return;
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }) as unknown as typeof fetch;
}

function sleep(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

const QUERY: ListReposQueryInput = { page: 1, per_page: 30 };

describe("GithubService external call timeout", () => {
  it("rejects instead of hanging when GitHub does not answer within the configured timeout", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    __setGithubFetchForTests(hangingFetch(signals));
    try {
      await withEnv({ GITHUB_REQUEST_TIMEOUT_MS: "50" }, async () => {
        const outcome = await Promise.race([
          service()
            .listRepos(QUERY, 111, "alice")
            .then(
              () => "resolved" as const,
              () => "rejected" as const,
            ),
          sleep(1500),
        ]);
        assert.equal(
          outcome,
          "rejected",
          "a hung GitHub request must be aborted by the request timeout, not awaited forever",
        );
        assert.ok(
          signals[0],
          "the timeout must reach fetch as an AbortSignal (Octokit request.signal)",
        );
      });
    } finally {
      __setGithubFetchForTests(null);
    }
  });

  it("pins the default GitHub request timeout to 15000 ms", () => {
    const env = validateEnv(baseEnv()) as unknown as Record<string, unknown>;
    assert.equal(
      env.githubRequestTimeoutMs,
      15000,
      "AppEnv.githubRequestTimeoutMs must default to 15000",
    );
  });

  it("reads the GitHub request timeout from GITHUB_REQUEST_TIMEOUT_MS", () => {
    const env = validateEnv(
      baseEnv({ GITHUB_REQUEST_TIMEOUT_MS: "2500" }),
    ) as unknown as Record<string, unknown>;
    assert.equal(env.githubRequestTimeoutMs, 2500);
  });

  it("rejects a non-numeric GITHUB_REQUEST_TIMEOUT_MS at env validation", () => {
    assert.throws(
      () => validateEnv(baseEnv({ GITHUB_REQUEST_TIMEOUT_MS: "abc" })),
      /\[env\] GITHUB_REQUEST_TIMEOUT_MS/,
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
  console.error(`github service timeout checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
