/**
 * CloneJobsRepository unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the other runners):
 *   `bun run build && bun dist/organizations/modules/projects/modules/repository/modules/workspaces/modules/clone/__tests__/clone-jobs.repository.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the in-memory clone-job store (no durable table exists yet):
 * idempotent enqueue, queued→cloning→ready/failed transitions,
 * error/progress fields, and per-user isolation for the same repo name.
 */
import assert from 'node:assert/strict';
import { CloneJobsRepository } from '../clone-jobs.repository';

const UID = '123e4567-e89b-12d3-a456-426614174001';
const OTHER_UID = '123e4567-e89b-12d3-a456-426614174002';
const PID = '123e4567-e89b-12d3-a456-426614174003';

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

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'enqueue stores a queued job and is idempotent while non-failed',
    run: () => {
      const repo = newRepo();
      const first = repo.enqueue({
        userId: UID,
        userSpace: UID,
        repoName: PID,
        repoUrl: 'https://example.com/demo.git',
      });
      assert.equal(first.created, true);
      assert.equal(first.job.status, 'queued');
      assert.equal(first.job.progress, 0);
      assert.equal(first.job.error, null);
      assert.equal(repo.get(UID, PID)?.status, 'queued');

      const second = repo.enqueue({
        userId: UID,
        userSpace: UID,
        repoName: PID,
        repoUrl: 'https://example.com/other.git',
      });
      assert.equal(second.created, false);
      assert.equal(second.job.repoUrl, 'https://example.com/demo.git');
      assert.equal(repo.get(UID, PID)?.repoUrl, 'https://example.com/demo.git');
    },
  },
  {
    name: 'transition queued → cloning → ready (progress/error fields)',
    run: () => {
      const repo = newRepo();
      repo.enqueue({ userId: UID, userSpace: UID, repoName: PID, repoUrl: '/tmp/src' });
      const cloning = repo.markCloning(UID, PID);
      assert.equal(cloning?.status, 'cloning');
      assert.equal(cloning?.progress, 10);
      assert.equal(cloning?.error, null);

      const midway = repo.markProgress(UID, PID, 70);
      assert.equal(midway?.status, 'cloning');
      assert.equal(midway?.progress, 70);

      const ready = repo.markReady(UID, PID);
      assert.equal(ready?.status, 'ready');
      assert.equal(ready?.progress, 100);
      assert.equal(ready?.error, null);
      assert.equal(repo.get(UID, PID)?.status, 'ready');
    },
  },
  {
    name: 'failed is terminal-looking but re-enqueue resets to queued',
    run: () => {
      const repo = newRepo();
      repo.enqueue({ userId: UID, userSpace: UID, repoName: PID, repoUrl: '/tmp/src' });
      repo.markCloning(UID, PID);
      const failed = repo.markFailed(UID, PID, 'clone blew up');
      assert.equal(failed?.status, 'failed');
      assert.equal(failed?.error, 'clone blew up');
      assert.equal(failed?.progress, 0);
      assert.equal(repo.get(UID, PID)?.error, 'clone blew up');

      const retry = repo.enqueue({
        userId: UID,
        userSpace: UID,
        repoName: PID,
        repoUrl: '/tmp/src',
      });
      assert.equal(retry.created, true);
      assert.equal(retry.job.status, 'queued');
      assert.equal(retry.job.error, null);
    },
  },
  {
    name: 'per-user isolation — same repo name, independent jobs',
    run: () => {
      const repo = newRepo();
      repo.enqueue({ userId: UID, userSpace: UID, repoName: PID, repoUrl: '/tmp/a' });
      repo.enqueue({ userId: OTHER_UID, userSpace: OTHER_UID, repoName: PID, repoUrl: '/tmp/b' });
      assert.equal(repo.key(UID, PID) === repo.key(OTHER_UID, PID), false);

      repo.markReady(UID, PID);
      assert.equal(repo.get(UID, PID)?.status, 'ready');
      assert.equal(repo.get(UID, PID)?.repoUrl, '/tmp/a');
      assert.equal(repo.get(OTHER_UID, PID)?.status, 'queued');
      assert.equal(repo.get(OTHER_UID, PID)?.repoUrl, '/tmp/b');

      // A missing key never invents a job.
      assert.equal(repo.get(OTHER_UID, '123e4567-e89b-12d3-a456-426614174004'), null);
      assert.equal(repo.transition(OTHER_UID, 'unknown-repo', 'ready'), null);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} clone-jobs checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} clone-jobs checks failed`);
  }
  console.log(`${checks.length}/${checks.length} clone-jobs checks passed`);
}

void main().catch((err: unknown) => {
  console.error(`clone-jobs checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
