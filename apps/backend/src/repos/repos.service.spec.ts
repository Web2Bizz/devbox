/**
 * Repos scanner unit checks — self-contained runner (no new deps, plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/repos/repos.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers: valid repo listed (users/ + orgs/ trees, no `workspace` segment),
 * no-git skipped silently, corrupted skipped with logger.warn({ path,
 * reason }), scope without projects/ skipped, `.secrets` never listed,
 * q/limit/offset filtering, invalid userSpace → BadRequest. Readonly: only
 * readdir/stat/realpath + git probes, no writes into scanned repos.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReposService } from './repos.service.js';
import { isValidGitRepo } from './repos-git.util.js';

interface WarnCall {
  path?: string;
  reason?: string;
}

function makeLogger() {
  const warns: WarnCall[] = [];
  return {
    warns,
    logger: {
      warn: (msg: unknown) => {
        warns.push(msg as WarnCall);
      },
    } as unknown as import('../common/app-logger.service.js').AppLogger,
  };
}

export const SPEC_UID = '123e4567-e89b-12d3-a456-426614174001';
export const SPEC_PID = '123e4567-e89b-12d3-a456-426614174002';
export const SPEC_PID_PLAIN = '123e4567-e89b-12d3-a456-426614174003';
export const SPEC_PID_BROKEN = '123e4567-e89b-12d3-a456-426614174004';
export const SPEC_OID = '123e4567-e89b-12d3-a456-426614174005';
export const SPEC_OPID = '123e4567-e89b-12d3-a456-426614174006';

/** tmp REPOS_ROOT users/<uuid>/projects/<uuid>/content (+ orgs/ mirror) fixture. */
function fixture(): { root: string; alice: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'repos-spec-'));
  const home = path.join(root, 'users', SPEC_UID, 'projects');
  // valid git repo (git init is enough for rev-parse + fsck to pass)
  const valid = path.join(home, SPEC_PID, 'content');
  mkdirSync(valid, { recursive: true });
  execFileSync('git', ['init', '-q', valid]);
  // plain dir, no .git
  mkdirSync(path.join(home, SPEC_PID_PLAIN, 'content'), { recursive: true });
  // corrupted: .git dir exists but is not a repo (rev-parse/fsck fail)
  const broken = path.join(home, SPEC_PID_BROKEN, 'content');
  mkdirSync(path.join(broken, '.git'), { recursive: true });
  writeFileSync(path.join(broken, '.git', 'HEAD'), 'garbage-not-a-ref\n');
  // reserved secrets dir (must never be listed)
  mkdirSync(path.join(home, SPEC_PID, '.secrets'), { recursive: true });
  mkdirSync(path.join(root, 'users', SPEC_UID, '.secrets'), { recursive: true });
  // org-scoped valid repo
  const orgValid = path.join(root, 'orgs', SPEC_OID, 'projects', SPEC_OPID, 'content');
  mkdirSync(orgValid, { recursive: true });
  execFileSync('git', ['init', '-q', orgValid]);
  // scope without projects/
  mkdirSync(path.join(root, 'users', 'lonely-scope'), { recursive: true });
  return { root, alice: SPEC_UID };
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'valid git repo passes validation',
    run: async () => {
      const { root } = fixture();
      const check = await isValidGitRepo(path.join(root, 'users', SPEC_UID, 'projects', SPEC_PID, 'content'));
      assert.equal(check.ok, true);
    },
  },
  {
    name: 'plain dir without .git is no-git (no warn)',
    run: async () => {
      const { root } = fixture();
      const { warns, logger } = makeLogger();
      const check = await isValidGitRepo(
        path.join(root, 'users', SPEC_UID, 'projects', SPEC_PID_PLAIN, 'content'),
        logger,
      );
      assert.equal(check.ok, false);
      assert.equal(check.reason, 'no-git');
      assert.deepEqual(warns, []);
    },
  },
  {
    name: 'corrupted repo fails with warn { path, reason }',
    run: async () => {
      const { root } = fixture();
      const { warns, logger } = makeLogger();
      const abs = path.join(root, 'users', SPEC_UID, 'projects', SPEC_PID_BROKEN, 'content');
      const check = await isValidGitRepo(abs, logger);
      assert.equal(check.ok, false);
      assert.ok(check.reason && check.reason !== 'no-git');
      assert.equal(warns.length, 1);
      assert.equal(warns[0].path, abs);
      assert.ok(warns[0].reason);
    },
  },
  {
    name: 'scanner lists only valid repos (skips no-git/corrupted/no-projects/.secrets)',
    run: async () => {
      const { root } = fixture();
      process.env.REPOS_ROOT = root;
      const { logger } = makeLogger();
      const svc = new ReposService(logger);
      const all = await svc.list(undefined, { limit: 50, offset: 0, q: '' });
      assert.equal(all.length, 2);
      const userEntry = all.find((e) => e.userSpace === SPEC_UID);
      assert.ok(userEntry);
      assert.equal(userEntry.name, SPEC_PID);
      assert.equal(userEntry.path, `users/${SPEC_UID}/projects/${SPEC_PID}/content`);
      assert.ok(!Number.isNaN(Date.parse(userEntry.updatedAt)));
      const orgEntry = all.find((e) => e.userSpace === SPEC_OID);
      assert.ok(orgEntry);
      assert.equal(orgEntry.path, `orgs/${SPEC_OID}/projects/${SPEC_OPID}/content`);
      assert.ok(all.every((e) => !e.path.includes('.secrets')));
    },
  },
  {
    name: 'q filter + limit/offset paginate without throwing',
    run: async () => {
      const { root } = fixture();
      process.env.REPOS_ROOT = root;
      const { logger } = makeLogger();
      const svc = new ReposService(logger);
      const hit = await svc.list(undefined, { limit: 50, offset: 0, q: SPEC_PID });
      assert.equal(hit.length, 1);
      const miss = await svc.list(undefined, { limit: 50, offset: 0, q: 'zzz-nope' });
      assert.deepEqual(miss, []);
      const page = await svc.list(undefined, { limit: 50, offset: 5, q: '' });
      assert.deepEqual(page, []);
    },
  },
  {
    name: 'per-space listing + invalid userSpace throws BadRequest',
    run: async () => {
      const { root } = fixture();
      process.env.REPOS_ROOT = root;
      const { logger } = makeLogger();
      const svc = new ReposService(logger);
      const one = await svc.list(SPEC_UID, { limit: 50, offset: 0, q: '' });
      assert.equal(one.length, 1);
      const empty = await svc.list('nobody-here', { limit: 50, offset: 0, q: '' });
      assert.deepEqual(empty, []);
      await assert.rejects(
        () => svc.list('../escape', { limit: 50, offset: 0, q: '' }),
        /userSpace/,
      );
    },
  },
  {
    name: 'unconfigured REPOS_ROOT → list denies with 503 EXTERNAL_UNAVAILABLE (never silent [])',
    run: async () => {
      const prevRepos = process.env.REPOS_ROOT;
      const prevProjects = process.env.PROJECTS_ROOT;
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
      try {
        const { logger } = makeLogger();
        const svc = new ReposService(logger);
        await assert.rejects(() => svc.list(undefined, { limit: 50, offset: 0, q: '' }), (err: unknown) => {
          const e = err as { code?: string; httpStatus?: number; status?: number };
          assert.equal(e.code, 'EXTERNAL_UNAVAILABLE');
          assert.equal(e.httpStatus ?? e.status, 503);
          return true;
        });
        assert.throws(() => svc.resolveRoot(), /EXTERNAL_UNAVAILABLE|temporarily|повторите/i);
      } finally {
        if (prevRepos === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = prevRepos;
        if (prevProjects === undefined) delete process.env.PROJECTS_ROOT;
        else process.env.PROJECTS_ROOT = prevProjects;
      }
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      // eslint-disable-next-line no-console
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`${failed}/${checks.length} repos scanner checks failed`);
    process.exitCode = 1;
  } else {
    // eslint-disable-next-line no-console
    console.log(`${checks.length}/${checks.length} repos scanner checks passed`);
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`repos scanner checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
