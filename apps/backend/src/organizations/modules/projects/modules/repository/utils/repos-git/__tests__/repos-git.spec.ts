/**
 * repos-git util unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the other runners):
 *   `bun run build && bun dist/organizations/modules/projects/modules/repository/utils/repos-git/__tests__/repos-git.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers `isValidGitRepo` (execFile, no shell, no network):
 * - plain directory without `.git` → `{ ok: false, reason: 'no-git' }`, no warn;
 * - real local repo (`git init -b main` + one empty commit) → `{ ok: true }`;
 * - `.git` dir that is not a repo → `rev-parse-failed` + logger.warn
 *   (`{ path, reason }`), never a throw for the whole listing.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isValidGitRepo } from '..';

type WarnCall = { path?: string; reason?: string };

function makeLogger() {
  const warns: Array<WarnCall> = [];
  return {
    warns,
    logger: {
      warn: (msg: unknown) => {
        warns.push(msg as WarnCall);
      },
    },
  };
}

/** Local-only git fixture: repo-scoped identity, one empty commit, no network. */
function initRepo(abs: string): void {
  mkdirSync(abs, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: abs, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'repos-git-spec@localhost'], {
    cwd: abs,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'repos-git-spec'], { cwd: abs, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: abs, stdio: 'ignore' });
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'plain dir without .git → no-git (no warn)',
    run: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'repos-git-plain-'));
      const dir = path.join(root, 'plain');
      mkdirSync(dir, { recursive: true });
      const { warns, logger } = makeLogger();
      const check = await isValidGitRepo(dir, logger);
      assert.equal(check.ok, false);
      assert.equal(check.reason, 'no-git');
      assert.deepEqual(warns, []);
    },
  },
  {
    name: 'local git repo (init -b main + empty commit) → ok',
    run: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'repos-git-valid-'));
      const dir = path.join(root, 'valid');
      initRepo(dir);
      const { warns, logger } = makeLogger();
      const check = await isValidGitRepo(dir, logger);
      assert.equal(check.ok, true);
      assert.equal(check.reason, undefined);
      assert.deepEqual(warns, []);
    },
  },
  {
    name: 'fake .git dir (not a repo) → rev-parse-failed + warn { path, reason }',
    run: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'repos-git-broken-'));
      const dir = path.join(root, 'broken');
      mkdirSync(path.join(dir, '.git'), { recursive: true });
      writeFileSync(path.join(dir, '.git', 'HEAD'), 'garbage-not-a-ref\n');
      const { warns, logger } = makeLogger();
      const check = await isValidGitRepo(dir, logger);
      assert.equal(check.ok, false);
      assert.equal(check.reason, 'rev-parse-failed');
      assert.equal(warns.length, 1);
      assert.equal(warns[0].path, dir);
      assert.equal(warns[0].reason, 'rev-parse-failed');
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
    console.error(`${failed}/${checks.length} repos-git checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} repos-git checks failed`);
  }
  console.log(`${checks.length}/${checks.length} repos-git checks passed`);
}

void main().catch((err: unknown) => {
  console.error(`repos-git checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
