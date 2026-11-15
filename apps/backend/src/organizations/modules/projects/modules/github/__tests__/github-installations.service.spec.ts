import assert from "node:assert/strict";
import { ForbiddenException } from "@nestjs/common";
import type { DbService } from "@common/db/db.service";
import type { GithubInstallationRow } from "@common/db/schema";
import { GithubInstallationsService } from "../github-installations.service";

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

function silentLogger() {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as ConstructorParameters<typeof GithubInstallationsService>[0];
}

function makeRow(over: Partial<GithubInstallationRow>): GithubInstallationRow {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const base: GithubInstallationRow = {
    id: "123e4567-e89b-12d3-a456-426614174000",
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

type DbState = {
  selects: number;
  inserts: number;
  updates: number;
  lastSet: Record<string, unknown> | null;
};

function fakeDb(existing: GithubInstallationRow | null): {
  db: DbService;
  state: DbState;
} {
  const state: DbState = {
    selects: 0,
    inserts: 0,
    updates: 0,
    lastSet: null,
  };
  const client = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            state.selects += 1;
            return existing ? [existing] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          state.inserts += 1;
          return [makeRow(values as Partial<GithubInstallationRow>)];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            state.updates += 1;
            state.lastSet = values;
            const merged = { ...(existing ?? {}), ...values };
            return [makeRow(merged as Partial<GithubInstallationRow>)];
          },
        }),
      }),
    }),
  };
  const db = {
    get client() {
      return client as never;
    },
  } as unknown as DbService;
  return { db, state };
}

function service(existing: GithubInstallationRow | null) {
  const { db, state } = fakeDb(existing);
  return {
    svc: new GithubInstallationsService(silentLogger(), db),
    state,
  };
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

describe("GithubInstallationsService.upsert ownership", () => {
  it("rejects rebinding an installation that already belongs to another user", async () => {
    const { svc, state } = service(
      makeRow({ userId: "alice", installationId: 111 }),
    );
    await assert.rejects(
      () => svc.upsert({ installationId: 111, userId: "bob" }, "cid-foreign"),
      isForbiddenInstallation,
    );
    assert.equal(state.updates, 0, "foreign owner must never be overwritten");
    assert.equal(state.inserts, 0);
  });

  it("allows claiming an installation whose owner is still unbound", async () => {
    const { svc, state } = service(
      makeRow({ userId: null, installationId: 111 }),
    );
    const record = await svc.upsert(
      { installationId: 111, userId: "alice" },
      "cid-claim",
    );
    assert.equal(record.userId, "alice");
    assert.equal(state.updates, 1);
  });

  it("allows upsert when the incoming userId matches the stored owner", async () => {
    const { svc, state } = service(
      makeRow({ userId: "alice", installationId: 111 }),
    );
    const record = await svc.upsert(
      { installationId: 111, userId: "alice", accountLogin: "acme-renamed" },
      "cid-same",
    );
    assert.equal(record.userId, "alice");
    assert.equal(record.accountLogin, "acme-renamed");
    assert.equal(state.updates, 1);
  });

  it("creates a new installation when no row exists yet", async () => {
    const { svc, state } = service(null);
    const record = await svc.upsert(
      { installationId: 222, userId: "bob" },
      "cid-new",
    );
    assert.equal(record.installationId, 222);
    assert.equal(record.userId, "bob");
    assert.equal(state.inserts, 1);
    assert.equal(state.updates, 0);
  });

  it("keeps the bound owner for webhook upserts that carry no userId", async () => {
    const { svc, state } = service(
      makeRow({ userId: "alice", installationId: 111 }),
    );
    const record = await svc.upsert(
      { installationId: 111, accountLogin: "acme-renamed" },
      "cid-webhook",
    );
    assert.equal(record.userId, "alice");
    assert.equal(state.updates, 1);
    assert.equal(state.lastSet?.userId, "alice");
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
  console.error(`github-installations checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
