import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { RequestIdentity } from "../../../../../../auth/identity.service";
import type { GithubAppService } from "../github-app.service";
import type { GithubInstallation } from "../github-installations.service";
import { GithubBindingService } from "../github-binding.service";
import { GithubController } from "../github.controller";
import type { GithubService } from "../github.service";
import { APP_STATE_TTL_MS, signAppState } from "../utils/app-state";

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

const IDENTITY: RequestIdentity = {
  id: "alice",
  email: "alice@example.com",
  mock: false,
};

function installation(over: Partial<GithubInstallation>): GithubInstallation {
  const now = "2025-01-01T00:00:00.000Z";
  const base: GithubInstallation = {
    userId: null,
    installationId: 111,
    accountLogin: "alice",
    accountType: "User",
    suspendedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...over };
}

type UpsertCall = { input: Record<string, unknown>; correlationId?: string };

function controller(opts: {
  accountLogin: string | null;
  createdAt?: string | null;
  bound: GithubInstallation | null;
  known: GithubInstallation | null;
  lookupError?: Error;
}) {
  const upserts: Array<UpsertCall> = [];
  const github = {
    async listRepos() {
      return [];
    },
    async status() {
      return { linked: false, owner: null, repo: null, branch: null, url: null };
    },
  };
  const appAuth = {
    isConfigured: () => true,
    async getInstallation(installationId: number) {
      if (opts.lookupError) throw opts.lookupError;
      return {
        id: installationId,
        account:
          opts.accountLogin === null
            ? null
            : { login: opts.accountLogin, type: "User" },
        createdAt:
          opts.createdAt === undefined
            ? new Date().toISOString()
            : opts.createdAt,
      };
    },
  };
  const installations = {
    async findByUserId() {
      return opts.bound;
    },
    async findByInstallationId() {
      return opts.known;
    },
    async upsert(input: Record<string, unknown>, correlationId?: string) {
      upserts.push({ input, correlationId });
      return installation({
        installationId: Number(input.installationId),
        userId: typeof input.userId === "string" ? input.userId : null,
      });
    },
  };
  const binding = new GithubBindingService(
    appAuth as unknown as GithubAppService,
    installations as unknown as ConstructorParameters<
      typeof GithubBindingService
    >[1],
  );
  const ctl = new GithubController(
    github as unknown as GithubService,
    appAuth as unknown as GithubAppService,
    installations as unknown as ConstructorParameters<typeof GithubController>[2],
    binding,
  );
  return { ctl, upserts };
}

function isForbiddenInstallation(err: unknown): boolean {
  assert.ok(
    err instanceof ForbiddenException,
    `expected ForbiddenException, got ${String(err)}`,
  );
  assert.equal(err.getStatus(), 403);
  const body = err.getResponse() as { code?: string };
  assert.equal(body.code, "GITHUB_INSTALLATION_FORBIDDEN");
  return true;
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

describe("GithubController.callback installation binding", () => {
  it("binds an installation when the caller presents a valid state", async () => {
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      bound: installation({ userId: "alice", installationId: 999, accountLogin: "alice" }),
      known: installation({ userId: null, installationId: 111, accountLogin: "alice" }),
    });
    const state = installUrlState(await installUrlFor(ctl, IDENTITY));
    const result = await ctl.callback(
      { installation_id: 111, setup_action: "install", state },
      IDENTITY,
      "cid-ok",
    );
    assert.deepEqual(result, { ok: true, installationId: 111 });
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].input.installationId, 111);
    assert.equal(upserts[0].input.userId, "alice");
    assert.equal(upserts[0].correlationId, "cid-ok");
  });

  it("propagates a GitHub installation lookup failure without writing", async () => {
    const lookupError = new NotFoundException({
      code: "GITHUB_NOT_INSTALLED",
      message: "GitHub App installation not found",
    });
    const { ctl, upserts } = controller({
      accountLogin: null,
      bound: installation({ userId: "alice", installationId: 999, accountLogin: "alice" }),
      known: null,
      lookupError,
    });
    const state = installUrlState(await installUrlFor(ctl, IDENTITY));
    await assert.rejects(
      () =>
        ctl.callback(
          { installation_id: 111, setup_action: "install", state },
          IDENTITY,
          "cid-missing",
        ),
      isNotInstalled,
    );
    assert.deepEqual(upserts, []);
  });
});

const SECOND_IDENTITY: RequestIdentity = {
  id: "bob",
  email: "bob@example.com",
  mock: false,
};

const TEST_APP_SLUG = "rush-code-test-app";
const STATE_SECRET = "whsec_state_spec_not_real";

const appPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
delete process.env.GITHUB_APP_INSTALLATION_ID;
delete process.env.GITHUB_STATE_SECRET;
process.env.APP_BACKEND_PORT = "3000";
process.env.GITHUB_APP_ID = "123456";
process.env.GITHUB_APP_PRIVATE_KEY = appPrivateKey;
process.env.GITHUB_APP_SLUG = TEST_APP_SLUG;
process.env.GITHUB_WEBHOOK_SECRET = STATE_SECRET;

type InstallUrlCall = (
  identity: RequestIdentity,
) => { url: string } | Promise<{ url: string }>;

async function installUrlFor(
  ctl: GithubController,
  identity: RequestIdentity,
): Promise<string> {
  const result = await (ctl.installUrl as unknown as InstallUrlCall)(identity);
  return result.url;
}

function installUrlState(url: string): string {
  const parsed = new URL(url);
  assert.equal(
    `${parsed.origin}${parsed.pathname}`,
    `https://github.com/apps/${TEST_APP_SLUG}/installations/new`,
    `unexpected install URL: ${url}`,
  );
  const state = parsed.searchParams.get("state");
  assert.ok(state, `expected a signed state in the install URL, got ${url}`);
  return state;
}

type CallbackQuery = {
  installation_id: number;
  setup_action?: string;
  state?: string;
};

async function callCallback(
  ctl: GithubController,
  query: CallbackQuery,
  identity: RequestIdentity,
  correlationId?: string,
): Promise<{ ok: boolean; installationId: number }> {
  return ctl.callback(
    query as unknown as Parameters<GithubController["callback"]>[0],
    identity,
    correlationId,
  );
}

function tamperWithState(state: string): string {
  const index = Math.floor(state.length / 2);
  const replacement = state[index] === "a" ? "b" : "a";
  return `${state.slice(0, index)}${replacement}${state.slice(index + 1)}`;
}

function isStateInvalid(err: unknown): boolean {
  assert.ok(
    err instanceof BadRequestException,
    `expected BadRequestException, got ${String(err)}`,
  );
  assert.equal(err.getStatus(), 400);
  const body = err.getResponse() as { code?: string };
  assert.equal(body.code, "GITHUB_STATE_INVALID");
  return true;
}

function isStateForbidden(err: unknown): boolean {
  assert.ok(
    err instanceof ForbiddenException,
    `expected ForbiddenException, got ${String(err)}`,
  );
  assert.equal(err.getStatus(), 403);
  const body = err.getResponse() as { code?: string };
  assert.equal(body.code, "GITHUB_STATE_FORBIDDEN");
  return true;
}

describe("GithubController signed install state", () => {
  it("issues a state that the same user's callback accepts and binds to that user", async () => {
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      bound: null,
      known: null,
    });
    const url = await installUrlFor(ctl, IDENTITY);
    const state = installUrlState(url);
    const result = await callCallback(
      ctl,
      { installation_id: 111, setup_action: "install", state },
      IDENTITY,
      "cid-state-ok",
    );
    assert.deepEqual(result, { ok: true, installationId: 111 });
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].input.installationId, 111);
    assert.equal(upserts[0].input.userId, "alice");
    assert.equal(upserts[0].correlationId, "cid-state-ok");
  });

  it("rejects a callback without state when the caller already has a binding, and writes nothing", async () => {
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      bound: installation({ userId: "alice", installationId: 999, accountLogin: "alice" }),
      known: installation({ userId: null, installationId: 111, accountLogin: "alice" }),
    });
    await assert.rejects(
      () =>
        callCallback(
          ctl,
          { installation_id: 111, setup_action: "install" },
          IDENTITY,
          "cid-bound-no-state",
        ),
      isStateInvalid,
    );
    assert.deepEqual(upserts, []);
  });

  it("rejects an expired state even when the caller already has a binding", async () => {
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      bound: installation({ userId: "alice", installationId: 999, accountLogin: "alice" }),
      known: installation({ userId: null, installationId: 111, accountLogin: "alice" }),
    });
    const state = signAppState(IDENTITY.id, STATE_SECRET, {
      nowMs: Date.now() - APP_STATE_TTL_MS * 2,
    });
    await assert.rejects(
      () =>
        callCallback(
          ctl,
          { installation_id: 111, setup_action: "install", state },
          IDENTITY,
          "cid-bound-expired-state",
        ),
      isStateInvalid,
    );
    assert.deepEqual(upserts, []);
  });

  it("rejects another user's state when the caller already has a binding", async () => {
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      bound: installation({ userId: "alice", installationId: 999, accountLogin: "alice" }),
      known: installation({ userId: null, installationId: 111, accountLogin: "alice" }),
    });
    const other = controller({
      accountLogin: "alice",
      bound: null,
      known: null,
    });
    const state = installUrlState(await installUrlFor(other.ctl, SECOND_IDENTITY));
    await assert.rejects(
      () =>
        callCallback(
          ctl,
          { installation_id: 111, setup_action: "install", state },
          IDENTITY,
          "cid-bound-foreign-state",
        ),
      isStateForbidden,
    );
    assert.deepEqual(upserts, []);
    assert.deepEqual(other.upserts, []);
  });

  it("rejects a callback without state (400 GITHUB_STATE_INVALID) and writes nothing", async () => {
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      bound: null,
      known: null,
    });
    await assert.rejects(
      () =>
        callCallback(
          ctl,
          { installation_id: 111, setup_action: "install" },
          IDENTITY,
          "cid-no-state",
        ),
      isStateInvalid,
    );
    assert.deepEqual(upserts, []);
  });

  it("rejects a tampered state (400 GITHUB_STATE_INVALID) and writes nothing", async () => {
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      bound: null,
      known: null,
    });
    const state = installUrlState(await installUrlFor(ctl, IDENTITY));
    const tampered = tamperWithState(state);
    assert.notEqual(tampered, state);
    await assert.rejects(
      () =>
        callCallback(
          ctl,
          { installation_id: 111, setup_action: "install", state: tampered },
          IDENTITY,
          "cid-tampered-state",
        ),
      isStateInvalid,
    );
    assert.deepEqual(upserts, []);
  });

  it("rejects a state issued for another user (403 GITHUB_STATE_FORBIDDEN) and writes nothing", async () => {
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      bound: null,
      known: null,
    });
    const other = controller({
      accountLogin: "alice",
      bound: null,
      known: null,
    });
    const state = installUrlState(await installUrlFor(other.ctl, SECOND_IDENTITY));
    await assert.rejects(
      () =>
        callCallback(
          ctl,
          { installation_id: 111, setup_action: "install", state },
          IDENTITY,
          "cid-foreign-state",
        ),
      isStateForbidden,
    );
    assert.deepEqual(upserts, []);
    assert.deepEqual(other.upserts, []);
  });
});

describe("GithubController first-time installation freshness", () => {
  it("rejects the first bind of an installation created before the state was issued", async () => {
    const issuedAt = Date.now() - 10 * 60_000;
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      createdAt: new Date(issuedAt - 10 * 60_000).toISOString(),
      bound: null,
      known: null,
    });
    const state = signAppState(IDENTITY.id, STATE_SECRET, {
      nowMs: issuedAt,
      ttlMs: APP_STATE_TTL_MS * 2,
    });
    await assert.rejects(
      () =>
        callCallback(
          ctl,
          { installation_id: 111, setup_action: "install", state },
          IDENTITY,
          "cid-stale-installation",
        ),
      isForbiddenInstallation,
    );
    assert.deepEqual(upserts, []);
  });

  it("binds a first-time installation created after the state was issued", async () => {
    const issuedAt = Date.now() - 60_000;
    const { ctl, upserts } = controller({
      accountLogin: "alice",
      createdAt: new Date().toISOString(),
      bound: null,
      known: null,
    });
    const state = signAppState(IDENTITY.id, STATE_SECRET, {
      nowMs: issuedAt,
      ttlMs: APP_STATE_TTL_MS,
    });
    const result = await callCallback(
      ctl,
      { installation_id: 111, setup_action: "install", state },
      IDENTITY,
      "cid-fresh-installation",
    );
    assert.deepEqual(result, { ok: true, installationId: 111 });
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].input.userId, "alice");
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
  console.error(`github controller checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
