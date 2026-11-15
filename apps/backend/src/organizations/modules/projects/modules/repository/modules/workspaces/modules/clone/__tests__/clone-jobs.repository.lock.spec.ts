import assert from "node:assert/strict";
import { CloneJobsRepository } from "../clone-jobs.repository";

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

const UID = "123e4567-e89b-12d3-a456-426614174001";
const OTHER_UID = "123e4567-e89b-12d3-a456-426614174002";
const PID = "123e4567-e89b-12d3-a456-426614174003";

function silentLogger(): ConstructorParameters<typeof CloneJobsRepository>[0] {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as ConstructorParameters<typeof CloneJobsRepository>[0];
}

function newRepo(): CloneJobsRepository {
  return new CloneJobsRepository(silentLogger());
}

function locksOf(repo: CloneJobsRepository): Map<string, Promise<void>> {
  return (repo as unknown as { locks: Map<string, Promise<void>> }).locks;
}

describe("CloneJobsRepository lock lifecycle", () => {
  it("releases the key after a successful job", async () => {
    const repo = newRepo();
    const key = repo.key(UID, PID);

    const result = await repo.withLock(UID, PID, async () => {
      assert.equal(locksOf(repo).has(key), true, "the lock must be visible while the job runs");
      return 42;
    });

    assert.equal(result, 42);
    assert.equal(locksOf(repo).has(key), false, "a successful job must drop its lock");
    assert.equal(locksOf(repo).size, 0);
  });

  it("releases the key after a failing job (error propagates)", async () => {
    const repo = newRepo();
    const key = repo.key(UID, PID);

    await assert.rejects(
      () =>
        repo.withLock(UID, PID, async () => {
          throw new Error("clone exploded");
        }),
      /clone exploded/,
    );

    assert.equal(locksOf(repo).has(key), false, "a failed job must drop its lock");
    assert.equal(locksOf(repo).size, 0);
  });

  it("releases both keys after two independent jobs finish", async () => {
    const repo = newRepo();

    await Promise.all([
      repo.withLock(UID, PID, async () => undefined),
      repo.withLock(OTHER_UID, PID, async () => undefined),
    ]);

    assert.equal(locksOf(repo).has(repo.key(UID, PID)), false);
    assert.equal(locksOf(repo).has(repo.key(OTHER_UID, PID)), false);
    assert.equal(locksOf(repo).size, 0);
  });

  it("starts a fresh chain when the same key is enqueued again", async () => {
    const repo = newRepo();
    let runs = 0;

    await repo.withLock(UID, PID, async () => {
      runs += 1;
    });
    await repo.withLock(UID, PID, async () => {
      runs += 1;
    });

    assert.equal(runs, 2, "a completed key must be reusable");
    assert.equal(locksOf(repo).size, 0);
  });

  it("does not grow the lock map across many completed jobs", async () => {
    const repo = newRepo();

    for (let i = 0; i < 25; i += 1) {
      await repo.withLock(UID, `${PID}-${i}`, async () => undefined);
      assert.equal(locksOf(repo).size, 0, "each completed job must release its key");
    }
  });

  it("serializes concurrent jobs for the same key and cleans up", async () => {
    const repo = newRepo();
    const order: Array<string> = [];

    const first = repo.withLock(UID, PID, async () => {
      order.push("first-start");
      await Promise.resolve();
      order.push("first-end");
    });
    const second = repo.withLock(UID, PID, async () => {
      order.push("second-start");
      order.push("second-end");
    });

    await Promise.all([first, second]);

    assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
    assert.equal(locksOf(repo).size, 0);
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} clone-lock checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`clone-lock checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
