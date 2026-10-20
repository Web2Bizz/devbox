/**
 * WorkspacePath organizations-layout unit checks — self-contained runner.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/workspaces/workspace-path.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the Card-2 canon (REPOS_ROOT strict, NO `workspace` segment):
 * - resolveUser/resolveOrg (+ *Strict) anchor under
 *   users/<uuid>/projects/<uuid>/content and orgs/<uuid>/projects/<uuid>/content;
 * - non-uuid ids → 400; traversal subs → 403 (incl. `../.secrets` escape);
 * - empty REPOS_ROOT → 503 reads / 500 strict writes (no fallback);
 * - ensureProjectDirs creates content + empty `.secrets` reserves.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspacePathService } from './workspace-path.service';

const UID = randomUUID();
const OID = randomUUID();
const PID = randomUUID();

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'resolveUser canon has no workspace segment',
    run: async () => {
      const paths = new WorkspacePathService();
      const r = await paths.resolveUser(UID, PID);
      const root = path.resolve(process.env.REPOS_ROOT as string);
      assert.equal(r.scope, 'user');
      assert.equal(r.absBase, path.resolve(root, 'users', UID.toLowerCase(), 'projects', PID.toLowerCase()));
      assert.equal(r.absRepo, path.join(r.absBase, 'content'));
      assert.equal(r.absSecrets, path.join(r.absBase, '.secrets'));
      assert.equal(r.abs, r.absRepo);
      assert.equal(r.rel, '.');
      assert.ok(!r.absRepo.includes('workspace'));
    },
  },
  {
    name: 'resolveOrg canon has no workspace segment',
    run: async () => {
      const paths = new WorkspacePathService();
      const r = await paths.resolveOrg(OID, PID);
      const root = path.resolve(process.env.REPOS_ROOT as string);
      assert.equal(r.scope, 'org');
      assert.equal(r.absBase, path.resolve(root, 'orgs', OID.toLowerCase(), 'projects', PID.toLowerCase()));
      assert.equal(r.absRepo, path.join(r.absBase, 'content'));
      assert.equal(r.scopeSecrets, path.resolve(root, 'orgs', OID.toLowerCase(), '.secrets'));
      assert.ok(!r.absRepo.includes('workspace'));
    },
  },
  {
    name: 'non-uuid ids rejected with 400 on all four resolvers',
    run: async () => {
      const paths = new WorkspacePathService();
      const bad = ['alice', 'system', '', '../escape', 'not-a-uuid', 'x'.repeat(37)];
      for (const b of bad) {
        await assert.rejects(() => paths.resolveUser(b, PID)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 400),
        );
        await assert.rejects(() => paths.resolveUser(UID, b)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 400),
        );
        await assert.rejects(() => paths.resolveOrg(b, PID)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 400),
        );
        await assert.rejects(() => paths.resolveOrg(OID, b)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 400),
        );
        await assert.rejects(() => paths.resolveUserStrict(b, PID)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 400),
        );
        await assert.rejects(() => paths.resolveOrgStrict(OID, b)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 400),
        );
      }
    },
  },
  {
    name: 'traversal subs rejected with 403 (incl. .secrets escape)',
    run: async () => {
      const paths = new WorkspacePathService();
      const evil = ['..', '../..', '../../etc', '/absolute', '..%2f..%2fetc', '%2e%2e/x', '../.secrets', 'content/../../orgs', 'a/../../b'];
      for (const sub of evil) {
        await assert.rejects(() => paths.resolveUser(UID, PID, sub)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 403),
        );
        await assert.rejects(() => paths.resolveOrg(OID, PID, sub)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 403),
        );
      }
      await assert.rejects(() => paths.resolveUser(UID, PID, 'a\0b')).then(
        () => {},
        (err) => assert.equal(statusOf(err), 403),
      );
    },
  },
  {
    name: 'nested legit sub stays inside content',
    run: async () => {
      const paths = new WorkspacePathService();
      const r = await paths.resolveUser(UID, PID, 'src/index.ts');
      assert.equal(r.rel, 'src/index.ts');
      assert.equal(r.abs, path.resolve(r.absRepo, 'src/index.ts'));
    },
  },
  {
    name: 'empty REPOS_ROOT → 503 reads / 500 strict writes',
    run: async () => {
      const paths = new WorkspacePathService();
      try {
        await paths.resolveUser(UID, PID);
        assert.fail('must throw');
      } catch (err) {
        assert.equal((err as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
      }
      try {
        await paths.resolveOrg(OID, PID);
        assert.fail('must throw');
      } catch (err) {
        assert.equal((err as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
      }
      try {
        await paths.resolveUserStrict(UID, PID);
        assert.fail('must throw');
      } catch (err) {
        assert.equal(statusOf(err), 500);
      }
      try {
        await paths.resolveOrgStrict(OID, PID);
        assert.fail('must throw');
      } catch (err) {
        assert.equal(statusOf(err), 500);
      }
    },
  },
  {
    name: 'ensureProjectDirs creates content + empty .secrets reserves',
    run: async () => {
      const paths = new WorkspacePathService();
      const r = await paths.resolveUserStrict(UID, PID);
      await paths.ensureProjectDirs(r);
      assert.equal(statSync(r.absRepo).isDirectory(), true);
      assert.equal(statSync(r.absSecrets).isDirectory(), true);
      assert.equal(statSync(r.scopeSecrets).isDirectory(), true);
      const o = await paths.resolveOrgStrict(OID, PID);
      await paths.ensureProjectDirs(o);
      assert.equal(statSync(o.absRepo).isDirectory(), true);
      assert.equal(statSync(o.absSecrets).isDirectory(), true);
      assert.equal(statSync(o.scopeSecrets).isDirectory(), true);
    },
  },
];

async function main(): Promise<void> {
  const prevRepos = process.env.REPOS_ROOT;
  const prevProjects = process.env.PROJECTS_ROOT;
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'ws-path-'));
  let failed = 0;
  for (const c of checks) {
    const needsClean = c.name.startsWith('empty REPOS_ROOT');
    if (needsClean) {
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
    } else {
      process.env.REPOS_ROOT = tmpRoot;
    }
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    } finally {
      if (prevRepos === undefined) delete process.env.REPOS_ROOT;
      else process.env.REPOS_ROOT = prevRepos;
      if (prevProjects === undefined) delete process.env.PROJECTS_ROOT;
      else process.env.PROJECTS_ROOT = prevProjects;
    }
  }
  // Restore caller jail (bun test shares one process across files).
  if (prevRepos === undefined) delete process.env.REPOS_ROOT;
  else process.env.REPOS_ROOT = prevRepos;
  if (failed > 0) {
    console.error(`${failed}/${checks.length} workspace-path checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} workspace-path checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} workspace-path checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`workspace-path checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
