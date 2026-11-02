import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import type { GithubAppService } from "../github-app.service";
import type { GithubInstallation } from "../github-installations.service";
import type { ListReposQueryInput } from "../github.dto";
import { GithubService, __setGithubFetchForTests } from "../github.service";

process.env.APP_BACKEND_PORT ??= "3000";
process.env.GITHUB_API_URL ??= "https://api.github.test";
process.env.EXTERNAL_RETRY_MAX_ATTEMPTS = "1";
process.env.EXTERNAL_RETRY_BASE_DELAY_MS = "0";
process.env.EXTERNAL_RETRY_MAX_DELAY_MS = "0";

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

function installation(over: Partial<GithubInstallation>): GithubInstallation {
  const now = "2025-01-01T00:00:00.000Z";
  const base: GithubInstallation = {
    userId: null,
    installationId: 111,
    accountLogin: "acme",
    accountType: "User",
    suspendedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...over };
}

type ListReposWithOwner = (
  query: ListReposQueryInput,
  installationId: number,
  userId: string,
) => Promise<unknown>;

type GithubServiceCtor = new (
  appAuth: unknown,
  logger: unknown,
  installations: unknown,
) => GithubService;

function service(stored: GithubInstallation | null) {
  const tokenCalls: Array<number> = [];
  const lookupCalls: Array<number> = [];
  const appAuth = {
    async getInstallationToken(installationId?: number): Promise<string> {
      tokenCalls.push(installationId ?? 0);
      return "ghs_test_token_not_real";
    },
  } as unknown as GithubAppService;
  const loggerAndInstallations = {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
    async findByInstallationId(installationId: number): Promise<GithubInstallation | null> {
      lookupCalls.push(installationId);
      return stored;
    },
  };
  const Ctor = GithubService as unknown as GithubServiceCtor;
  const svc = new Ctor(appAuth, loggerAndInstallations, loggerAndInstallations);
  return {
    svc: svc as unknown as { listRepos: ListReposWithOwner },
    tokenCalls,
    lookupCalls,
  };
}

const QUERY: ListReposQueryInput = { page: 1, per_page: 30 };

function stubFetchRepos(repositories: Array<unknown>): void {
  __setGithubFetchForTests((async () =>
    new Response(JSON.stringify({ total_count: repositories.length, repositories }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch);
}

function isNotInstalled(err: unknown): boolean {
  assert.ok(
    err instanceof NotFoundException,
    `expected NotFoundException, got ${String(err)}`,
  );
  assert.equal(err.getStatus(), 404);
  const body = err.getResponse() as { code?: string };
  assert.equal(body.code, "GITHUB_NOT_INSTALLED");
  return true;
}

describe("GithubService.listRepos installation ownership", () => {
  it("rejects a stored installation owned by another user before minting a token", async () => {
    stubFetchRepos([]);
    try {
      const { svc, tokenCalls, lookupCalls } = service(
        installation({ installationId: 111, userId: "bob" }),
      );
      await assert.rejects(
        () => svc.listRepos(QUERY, 111, "alice"),
        isNotInstalled,
      );
      assert.deepEqual(lookupCalls, [111]);
      assert.deepEqual(
        tokenCalls,
        [],
        "a foreign installation must never reach getInstallationToken",
      );
    } finally {
      __setGithubFetchForTests(null);
    }
  });

  it("mints the installation token and returns repos for the owning user", async () => {
    stubFetchRepos([
      {
        id: 1296269,
        name: "my-app",
        full_name: "acme/my-app",
        private: false,
        default_branch: "main",
        html_url: "https://github.com/acme/my-app",
        owner: { login: "acme" },
      },
    ]);
    try {
      const { svc, tokenCalls } = service(
        installation({ installationId: 111, userId: "alice" }),
      );
      const repos = (await svc.listRepos(QUERY, 111, "alice")) as Array<
        Record<string, unknown>
      >;
      assert.deepEqual(tokenCalls, [111]);
      assert.equal(repos.length, 1);
      assert.deepEqual(repos[0], {
        id: 1296269,
        owner: "acme",
        name: "my-app",
        fullName: "acme/my-app",
        private: false,
        defaultBranch: "main",
        url: "https://github.com/acme/my-app",
      });
    } finally {
      __setGithubFetchForTests(null);
    }
  });

  it("returns an empty list when GitHub reports no repositories", async () => {
    stubFetchRepos([]);
    try {
      const { svc } = service(installation({ installationId: 111, userId: "alice" }));
      assert.deepEqual(await svc.listRepos(QUERY, 111, "alice"), []);
    } finally {
      __setGithubFetchForTests(null);
    }
  });

  it("refuses to mint a token when the installation is absent from the registry", async () => {
    stubFetchRepos([]);
    try {
      const { svc, tokenCalls, lookupCalls } = service(null);
      await assert.rejects(() => svc.listRepos(QUERY, 111, "alice"), isNotInstalled);
      assert.deepEqual(lookupCalls, [111]);
      assert.deepEqual(
        tokenCalls,
        [],
        "an unknown installation must never reach getInstallationToken",
      );
    } finally {
      __setGithubFetchForTests(null);
    }
  });

  it("refuses to mint a token for a registry row without an owner", async () => {
    stubFetchRepos([]);
    try {
      const { svc, tokenCalls } = service(
        installation({ installationId: 111, userId: null }),
      );
      await assert.rejects(() => svc.listRepos(QUERY, 111, "alice"), isNotInstalled);
      assert.deepEqual(
        tokenCalls,
        [],
        "an ownerless installation must never reach getInstallationToken",
      );
    } finally {
      __setGithubFetchForTests(null);
    }
  });

  it("normalizes a repository payload with missing optional fields", async () => {
    stubFetchRepos([{ id: "not-a-number", full_name: "acme/thing" }]);
    try {
      const { svc } = service(installation({ installationId: 111, userId: "alice" }));
      const repos = (await svc.listRepos(QUERY, 111, "alice")) as Array<
        Record<string, unknown>
      >;
      assert.deepEqual(repos[0], {
        id: 0,
        owner: "acme",
        name: "thing",
        fullName: "acme/thing",
        private: false,
        defaultBranch: "main",
        url: "https://github.com/acme/thing",
      });
    } finally {
      __setGithubFetchForTests(null);
    }
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
  console.error(`github service checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
