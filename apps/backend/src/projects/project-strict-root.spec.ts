/**
 * Project strict-root unit checks — self-contained runner (no new deps).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/projects/project-strict-root.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the strict storage-root canon for project writes (organizations
 * layout — users/<ownerUuid>/projects/<id>/content, no `workspace` segment):
 * - empty REPOS_ROOT → requireExplicitRoot/resolveUserStrict throw 500
 *   before any mkdir/INSERT; ProjectsService.create() throws and
 *   DbService.insert is NEVER called (no rows written);
 * - non-uuid ownerId → create() throws 400 before any mkdir/INSERT;
 * - enrich() with unconfigured storage → corrupted=true,
 *   reason `storage-unconfigured` (never throws);
 * - explicit REPOS_ROOT keeps working (strict resolve inside jail);
 * - update() rejects ownerId change with 400 (no orphaned dirs).
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspacePathService } from '../workspaces/workspace-path.service.js';
import { ProjectsService } from './projects.service.js';

const silentLogger = {
  debug() {},
  info() {},
  log() {},
  warn() {},
  error() {},
  fatal() {},
} as unknown as ConstructorParameters<typeof ProjectsService>[0];

function makeService(dbClient: unknown) {
  const db = { get client() { return dbClient; } } as unknown as ConstructorParameters<typeof ProjectsService>[1];
  const paths = new WorkspacePathService();
  return new ProjectsService(silentLogger, db, paths);
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'requireExplicitRoot throws 500 on empty REPOS_ROOT (no fallback)',
    run: () => {
      const paths = new WorkspacePathService();
      assert.equal(paths.isExplicitRootConfigured(), false);
      assert.throws(() => paths.requireExplicitRoot(), /not configured/i);
      try {
        paths.requireExplicitRoot();
        assert.fail('must throw');
      } catch (err) {
        assert.equal((err as { status?: number }).status, 500);
      }
    },
  },
  {
    name: 'resolveUserStrict throws before any disk/DB touch on empty root',
    run: async () => {
      const paths = new WorkspacePathService();
      await assert.rejects(() =>
        paths.resolveUserStrict(
          '123e4567-e89b-12d3-a456-426614174001',
          '123e4567-e89b-12d3-a456-426614174002',
        ),
      );
    },
  },
  {
    name: 'create() with non-uuid ownerId throws 400, insert NEVER called',
    run: async () => {
      let insertCalled = 0;
      const fakeClient = {
        insert() {
          insertCalled += 1;
          throw new Error('insert must not be called for a bad ownerId');
        },
      };
      const svc = makeService(fakeClient);
      await assert.rejects(
        () => svc.create({ name: 'bad-owner', ownerId: 'alice' }, 'cid-strict-owner'),
        /ownerId must be a uuid/,
      );
      assert.equal(insertCalled, 0);
    },
  },
  {
    name: 'create() with empty REPOS_ROOT throws, DbService.insert NEVER called',
    run: async () => {
      const paths = new WorkspacePathService();
      void paths;
      let insertCalled = 0;
      const fakeClient = {
        insert() {
          insertCalled += 1;
          throw new Error('insert must not be called when storage is unconfigured');
        },
      };
      const svc = makeService(fakeClient);
      await assert.rejects(
        () => svc.create({ name: 'should-not-exist' }, 'cid-strict-1'),
        /not configured|storage/i,
      );
      assert.equal(insertCalled, 0);
    },
  },
  {
    name: 'enrich() without root → corrupted=true reason storage-unconfigured',
    run: async () => {
      const svc = makeService({});
      const raw = {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'demo',
        description: null,
        githubOwner: null,
        githubRepo: null,
        githubBranch: null,
        githubUrl: null,
        ownerId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        corrupted: false,
        corruptedReason: null,
      };
      const out = await (svc as unknown as { enrich: (p: typeof raw, cid?: string) => Promise<typeof raw> }).enrich(raw, 'cid-strict-2');
      assert.equal(out.corrupted, true);
      assert.equal(out.corruptedReason, 'storage-unconfigured');
    },
  },
  {
    name: 'update() rejects ownerId change with 400 (immutable, no orphan)',
    run: async () => {
      let updated = false;
      const fakeClient = {
        select() {
          return {
            from() {
              return {
                where() {
                  return {
                    limit() {
                      return Promise.resolve([
                        {
                          id: '00000000-0000-4000-8000-000000000002',
                          name: 'demo',
                          description: null,
                          githubOwner: null,
                          githubRepo: null,
                          githubBranch: null,
                          githubUrl: null,
                          ownerId: 'alice',
                          createdAt: new Date(),
                          updatedAt: new Date(),
                        },
                      ]);
                    },
                  };
                },
              };
            },
          };
        },
        update() {
          updated = true;
          return { set() { return { where() { return { returning: () => Promise.resolve([]) }; } }; } };
        },
      };
      const svc = makeService(fakeClient);
      await assert.rejects(
        // getOrThrow enriches (storage-unconfigured → corrupted, still returns row),
        // then update() must reject the owner change before any UPDATE.
        () => svc.update('00000000-0000-4000-8000-000000000002', { ownerId: '123e4567-e89b-12d3-a456-426614174099' }, 'cid-strict-3'),
        /ownerId is immutable/,
      );
      assert.equal(updated, false);
    },
  },
  {
    name: 'explicit REPOS_ROOT keeps strict resolve inside jail (users canon)',
    run: async () => {
      const prev = process.env.REPOS_ROOT;
      const root = mkdtempSync(path.join(tmpdir(), 'proj-strict-'));
      process.env.REPOS_ROOT = root;
      try {
        const paths = new WorkspacePathService();
        assert.equal(paths.isExplicitRootConfigured(), true);
        assert.equal(paths.requireExplicitRoot(), path.resolve(root));
        const owner = '123e4567-e89b-12d3-a456-426614174001';
        const id = '123e4567-e89b-12d3-a456-426614174000';
        const resolved = await paths.resolveUserStrict(owner, id);
        assert.equal(
          resolved.absRepo,
          path.resolve(root, 'users', owner, 'projects', id, 'content'),
        );
        const jailReal = await paths.realStrictRoot();
        await paths.assertInsideJail(resolved.absRepo, jailReal);
        await paths.ensureProjectDirs(resolved);
        const org = await paths.resolveOrgStrict(owner, id);
        assert.equal(
          org.absRepo,
          path.resolve(root, 'orgs', owner, 'projects', id, 'content'),
        );
      } finally {
        if (prev === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = prev;
      }
    },
  },
];

async function main(): Promise<void> {
  // NOTE (bun test shares one process across spec files): never leave the
  // process env empty between awaits — force the unconfigured state ONLY
  // around each negative check and restore immediately after, so parallel
  // mains (repos scanner, disk-mapping) keep seeing a valid root.
  let failed = 0;
  for (const c of checks) {
    const prevRepos = process.env.REPOS_ROOT;
    const prevProjects = process.env.PROJECTS_ROOT;
    const needsClean = c.name !== 'explicit REPOS_ROOT keeps strict resolve inside jail';
    if (needsClean) {
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
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
  if (failed > 0) {
    console.error(`${failed}/${checks.length} project strict-root checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} project strict-root checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} project strict-root checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`project strict-root checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
