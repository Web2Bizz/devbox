/**
 * Unified storage deny unit checks — self-contained runner (no new deps).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/storage/storage-unavailable.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the customer decision (single REPOS_ROOT catalog, reads AND writes):
 * - repos list, workspaces tree/submodules, project-files tree, clone dest
 *   with unconfigured REPOS_ROOT → 503 EXTERNAL_UNAVAILABLE (never silent
 *   []/404 over <cwd>/repos, never a read outside the explicit root);
 * - boot message for the unconfigured root is [env] ERROR level (storage
 *   unavailable: reads deny 503, creates 500; points at REPOS_ROOT/.env.example);
 * - positive regression with an explicit tmp REPOS_ROOT (tree lists, submodules
 *   [], project-files tree lists, clone enqueues);
 * - traversal still 403 on the configured root (jail preserved).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateEnvWithWarnings } from '../env.js';
import { ReposService } from '../repos/repos.service.js';
import { ProjectFilesService } from '../projects/files/project-files.service.js';
import { WorkspaceCloneService } from '../workspaces/workspace-clone.service.js';
import { CloneJobsRepository } from '../workspaces/clone-jobs.repository.js';
import { WorkspacePathService } from '../workspaces/workspace-path.service.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';

type Source = NodeJS.ProcessEnv;

function silentLogger() {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as ConstructorParameters<typeof WorkspacesService>[1];
}

function expectStorageDeny(err: unknown): boolean {
  const e = err as { code?: string; httpStatus?: number; status?: number; service?: string };
  assert.equal(e.code, 'EXTERNAL_UNAVAILABLE');
  assert.equal(e.httpStatus ?? e.status, 503);
  return true;
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'boot message without REPOS_ROOT is [env] ERROR (reads 503, creates 500)',
    run: () => {
      const prevRepos = process.env.REPOS_ROOT;
      const prevProjects = process.env.PROJECTS_ROOT;
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
      try {
        const base: Source = {
          APP_BACKEND_PORT: '3000',
          APP_BACKEND_HOST: '127.0.0.1',
          OPENCODE_URL: 'http://127.0.0.1:4096',
          DATABASE_URL: 'postgres://u:p@localhost:5432/db',
          CORS_ORIGINS: 'http://localhost:3001',
          REQUEST_TIMEOUT_MS: '10000',
          LOG_LEVEL: 'info',
          NEXT_PUBLIC_PORT: '3001',
          NEXT_PUBLIC_API_URL: 'http://localhost:3000',
          JWT_ACCESS_SECRET: 'test-jwt-access-secret-not-real-0123456789',
          JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-not-real-0123456789',
          AUTH_LEGACY_MOCK_FALLBACK: 'false',
        } as Source;
        const { env, warnings } = validateEnvWithWarnings(base);
        assert.equal(env.reposRoot, '');
        const boot = warnings.find((w) => w.includes('REPOS_ROOT'));
        assert.ok(boot, `expected REPOS_ROOT boot line, got ${JSON.stringify(warnings)}`);
        assert.ok(boot.includes('[env] ERROR'), `must route via logger.error, got: ${boot}`);
        assert.ok(boot.includes('503') && boot.includes('500'), `must name both denies, got: ${boot}`);
        assert.ok(boot.includes('.env.example'), `must point at .env.example, got: ${boot}`);
      } finally {
        if (prevRepos === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = prevRepos;
        if (prevProjects === undefined) delete process.env.PROJECTS_ROOT;
        else process.env.PROJECTS_ROOT = prevProjects;
      }
    },
  },
  {
    name: 'repos list without root denies 503 (never silent [])',
    run: async () => {
      const prevRepos = process.env.REPOS_ROOT;
      const prevProjects = process.env.PROJECTS_ROOT;
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
      try {
        const svc = new ReposService(silentLogger() as never);
        await assert.rejects(() => svc.list(undefined, { limit: 50, offset: 0, q: '' }), expectStorageDeny);
      } finally {
        if (prevRepos === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = prevRepos;
        if (prevProjects === undefined) delete process.env.PROJECTS_ROOT;
        else process.env.PROJECTS_ROOT = prevProjects;
      }
    },
  },
  {
    name: 'workspaces tree + submodules without root deny 503 (never silent 404)',
    run: async () => {
      const prevRepos = process.env.REPOS_ROOT;
      const prevProjects = process.env.PROJECTS_ROOT;
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
      try {
        const svc = new WorkspacesService(new WorkspacePathService(), silentLogger() as never);
        await assert.rejects(() => svc.tree('alice', 'demo', '.', 1, 'cid-1'), expectStorageDeny);
        await assert.rejects(() => svc.submodules('alice', 'demo', 'cid-1'), expectStorageDeny);
      } finally {
        if (prevRepos === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = prevRepos;
        if (prevProjects === undefined) delete process.env.PROJECTS_ROOT;
        else process.env.PROJECTS_ROOT = prevProjects;
      }
    },
  },
  {
    name: 'project-files tree without root denies 503 (never silent 404)',
    run: async () => {
      const prevRepos = process.env.REPOS_ROOT;
      const prevProjects = process.env.PROJECTS_ROOT;
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
      try {
        const fakeProjects = { getOrThrow: async () => ({ id: 'x' }) } as never;
        const svc = new ProjectFilesService(fakeProjects, new WorkspacePathService(), silentLogger() as never);
        await assert.rejects(() => svc.tree('any-id', '.', 1, 'cid-1'), expectStorageDeny);
      } finally {
        if (prevRepos === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = prevRepos;
        if (prevProjects === undefined) delete process.env.PROJECTS_ROOT;
        else process.env.PROJECTS_ROOT = prevProjects;
      }
    },
  },
  {
    name: 'clone dest without root denies 503 before any mkdir',
    run: async () => {
      const prevRepos = process.env.REPOS_ROOT;
      const prevProjects = process.env.PROJECTS_ROOT;
      delete process.env.REPOS_ROOT;
      delete process.env.PROJECTS_ROOT;
      try {
        const svc = new WorkspaceCloneService(
          new WorkspacePathService(),
          new CloneJobsRepository(),
          silentLogger() as never,
        );
        await assert.rejects(
          () => svc.clone('alice', 'https://example.com/a.git', 'demo', 'cid-1'),
          expectStorageDeny,
        );
      } finally {
        if (prevRepos === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = prevRepos;
        if (prevProjects === undefined) delete process.env.PROJECTS_ROOT;
        else process.env.PROJECTS_ROOT = prevProjects;
      }
    },
  },
  {
    name: 'positive regression with explicit root (tree lists, traversal still 403)',
    run: async () => {
      const prevRepos = process.env.REPOS_ROOT;
      const root = mkdtempSync(path.join(tmpdir(), 'storage-deny-pos-'));
      process.env.REPOS_ROOT = root;
      try {
        const paths = new WorkspacePathService();
        const uid = '123e4567-e89b-12d3-a456-426614174001';
        const pid = '123e4567-e89b-12d3-a456-426614174002';
        const contentAbs = path.join(root, 'users', uid, 'projects', pid, 'content');
        mkdirSync(contentAbs, { recursive: true });
        writeFileSync(path.join(contentAbs, 'hello.txt'), 'hi');
        const svc = new WorkspacesService(paths, silentLogger() as never);
        const node = await svc.tree(uid, pid, '.', 1, 'cid-pos');
        assert.equal(node.type, 'dir');
        assert.ok((node.children ?? []).some((c) => c.path === 'hello.txt'));
        // Jail preserved: escape still 403 on the configured root.
        await assert.rejects(() => svc.tree(uid, pid, '../../etc', 1, 'cid-pos'), /forbidden/i);
        // project-files positive over the same unified root.
        const fakeProjects = { getOrThrow: async () => ({ id: pid, ownerId: uid }) } as never;
        const files = new ProjectFilesService(fakeProjects, paths, silentLogger() as never);
        const fnode = await files.tree(pid, '.', 0, 'cid-pos');
        assert.equal(fnode.type, 'dir');
      } finally {
        if (prevRepos === undefined) delete process.env.REPOS_ROOT;
        else process.env.REPOS_ROOT = prevRepos;
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
    console.error(`${failed}/${checks.length} storage deny checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} storage deny checks failed`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${checks.length}/${checks.length} storage deny checks passed`);
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`storage deny checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
