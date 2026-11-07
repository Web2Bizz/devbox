/**
 * WorkspacePath organizations-layout unit checks — self-contained runner.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/common/storage/__tests__/workspace-path.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the org-only canon (REPOS_ROOT strict, NO `workspace` segment,
 * no user homes):
 * - resolveOrg (+ *Strict) anchors under orgs/<uuid>/projects/<uuid>/content;
 * - non-uuid ids → 400; traversal subs → 403 (incl. `../.secrets` escape);
 * - empty REPOS_ROOT → 503 reads / 500 strict writes (no fallback);
 * - ensureProjectDirs creates content + empty `.secrets` reserves;
 * - fs primitives (single jail): ensureDir/readDir/statPath/removeDir on a
 *   tmp dir — statPath(ENOENT) → null, removeDir recursive+force defaults.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspacePathService } from '../workspace-path.service';

const OID = randomUUID();
const PID = randomUUID();

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'resolveOrg canon has no workspace segment (no user homes)',
    run: async () => {
      const paths = new WorkspacePathService();
      const r = await paths.resolveOrg(OID, PID);
      const root = path.resolve(process.env.REPOS_ROOT as string);
      assert.equal(r.scope, 'org');
      assert.equal(r.absBase, path.resolve(root, 'orgs', OID.toLowerCase(), 'projects', PID.toLowerCase()));
      assert.equal(r.absRepo, path.join(r.absBase, 'content'));
      assert.equal(r.scopeSecrets, path.resolve(root, 'orgs', OID.toLowerCase(), '.secrets'));
      assert.ok(!r.absRepo.includes('workspace'));
      assert.ok(!r.absBase.includes(`${path.sep}users${path.sep}`));
    },
  },
  {
    name: 'user-space resolution is removed (resolveUser gone)',
    run: async () => {
      const paths = new WorkspacePathService();
      assert.equal(
        (paths as unknown as Record<string, unknown>).resolveUser,
        undefined,
      );
      assert.equal(
        (paths as unknown as Record<string, unknown>).resolveUserStrict,
        undefined,
      );
    },
  },
  {
    name: 'non-uuid ids rejected with 400 on both org resolvers',
    run: async () => {
      const paths = new WorkspacePathService();
      const bad = ['alice', 'system', '', '../escape', 'not-a-uuid', 'x'.repeat(37)];
      for (const b of bad) {
        await assert.rejects(() => paths.resolveOrg(b, PID)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 400),
        );
        await assert.rejects(() => paths.resolveOrg(OID, b)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 400),
        );
        await assert.rejects(() => paths.resolveOrgStrict(b, PID)).then(
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
        await assert.rejects(() => paths.resolveOrg(OID, PID, sub)).then(
          () => {},
          (err) => assert.equal(statusOf(err), 403),
        );
      }
      await assert.rejects(() => paths.resolveOrg(OID, PID, 'a\0b')).then(
        () => {},
        (err) => assert.equal(statusOf(err), 403),
      );
    },
  },
  {
    name: 'nested legit sub stays inside content',
    run: async () => {
      const paths = new WorkspacePathService();
      const r = await paths.resolveOrg(OID, PID, 'src/index.ts');
      assert.equal(r.rel, 'src/index.ts');
      assert.equal(r.abs, path.resolve(r.absRepo, 'src/index.ts'));
    },
  },
  {
    name: 'empty REPOS_ROOT → 503 reads / 500 strict writes',
    run: async () => {
      const paths = new WorkspacePathService();
      try {
        await paths.resolveOrg(OID, PID);
        assert.fail('must throw');
      } catch (err) {
        assert.equal((err as { code?: string }).code, 'EXTERNAL_UNAVAILABLE');
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
      const o = await paths.resolveOrgStrict(OID, PID);
      await paths.ensureProjectDirs(o);
      assert.equal(statSync(o.absRepo).isDirectory(), true);
      assert.equal(statSync(o.absSecrets).isDirectory(), true);
      assert.equal(statSync(o.scopeSecrets).isDirectory(), true);
    },
  },
  {
    name: 'fs primitives over a tmp dir (ensureDir/readDir/statPath/removeDir)',
    run: async () => {
      const paths = new WorkspacePathService();
      const base = mkdtempSync(path.join(tmpdir(), 'ws-path-primitives-'));
      const dir = path.join(base, 'nested', 'deep');

      // Missing path → null (no throw), unlike raw stat.
      assert.equal(await paths.statPath(dir), null);
      await paths.ensureDir(dir);
      assert.equal(statSync(dir).isDirectory(), true);
      // Idempotent (`mkdir -p` semantics).
      await paths.ensureDir(dir);

      writeFileSync(path.join(dir, 'file.txt'), 'hi');
      mkdirSync(path.join(dir, 'child'));
      const entries = await paths.readDir(dir);
      const byName = new Map(entries.map((e) => [e.name, e]));
      assert.equal(entries.length, 2);
      assert.equal(byName.get('file.txt')?.isFile(), true);
      assert.equal(byName.get('file.txt')?.isDirectory(), false);
      assert.equal(byName.get('child')?.isDirectory(), true);
      assert.equal((await paths.statPath(path.join(dir, 'file.txt')))?.isFile(), true);

      // Defaults are recursive + force: the tree goes away, a missing path is fine.
      await paths.removeDir(dir);
      assert.equal(await paths.statPath(dir), null);
      await paths.removeDir(dir);
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
