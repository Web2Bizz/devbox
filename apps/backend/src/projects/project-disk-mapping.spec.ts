/**
 * Project disk-mapping unit checks — self-contained runner (no new deps).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/projects/project-disk-mapping.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the frozen disk-first layout spec from ProjectsService
 * (organizations epic, no `workspace` segment):
 * ownerKey=ownerKeyOrThrow(ownerId ?? SYSTEM_OWNER_UUID), home=
 * users/<ownerUuid>/projects/<projectUuid>/{content,.secrets} — uuid ids
 * are 400-rejected otherwise, the layout is stable across renames, and
 * traversal shapes are rejected (400/403) before any disk write.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspacePathService } from '../workspaces/workspace-path.service.js';
import { SYSTEM_OWNER_UUID, ownerKeyOrThrow } from './projects.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'ownerId ?? SYSTEM_OWNER_UUID maps deterministically to one user home',
    run: async () => {
      assert.match(SYSTEM_OWNER_UUID, UUID_RE);
      assert.equal(ownerKeyOrThrow(null), SYSTEM_OWNER_UUID);
      const paths = new WorkspacePathService();
      const id = randomUUID();
      const a = await paths.resolveUser(ownerKeyOrThrow(null), id);
      const b = await paths.resolveUser(SYSTEM_OWNER_UUID, id);
      assert.equal(a.absRepo, b.absRepo);
      const other = await paths.resolveUser(randomUUID(), id);
      assert.notEqual(a.absRepo, other.absRepo);
    },
  },
  {
    name: 'non-uuid ownerId rejected (400) before any write',
    run: () => {
      assert.throws(() => ownerKeyOrThrow('alice'), /ownerId must be a uuid/);
      assert.throws(() => ownerKeyOrThrow('system'), /ownerId must be a uuid/);
      assert.throws(() => ownerKeyOrThrow('../escape'), /ownerId must be a uuid/);
    },
  },
  {
    name: 'uuid project id is a valid home under the user jail',
    run: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'proj-map-'));
      process.env.REPOS_ROOT = root;
      const paths = new WorkspacePathService();
      const id = randomUUID();
      assert.match(id, UUID_RE);
      const resolved = await paths.resolveUser(SYSTEM_OWNER_UUID, id);
      assert.equal(
        resolved.absRepo,
        path.resolve(root, 'users', SYSTEM_OWNER_UUID, 'projects', id, 'content'),
      );
      assert.ok(!resolved.absRepo.includes('workspace'));
    },
  },
  {
    name: 'layout is stable across renames (name is display-only)',
    run: async () => {
      const paths = new WorkspacePathService();
      const id = randomUUID();
      const before = await paths.resolveUser(SYSTEM_OWNER_UUID, id);
      const after = await paths.resolveUser(SYSTEM_OWNER_UUID, id);
      assert.equal(before.absRepo, after.absRepo);
    },
  },
  {
    name: 'non-uuid project ids rejected before any write (400)',
    run: async () => {
      const paths = new WorkspacePathService();
      await assert.rejects(() => paths.resolveUser(SYSTEM_OWNER_UUID, '..'));
      await assert.rejects(() => paths.resolveUser(SYSTEM_OWNER_UUID, '.'));
      await assert.rejects(() => paths.resolveUser(SYSTEM_OWNER_UUID, '../escape'));
      await assert.rejects(() => paths.resolveUser('alice', randomUUID()));
    },
  },
  {
    name: 'nested escape via subPath rejected (403, incl. .secrets)',
    run: async () => {
      const paths = new WorkspacePathService();
      const id = randomUUID();
      await assert.rejects(() => paths.resolveUser(SYSTEM_OWNER_UUID, id, '../../etc'));
      await assert.rejects(() => paths.resolveUser(SYSTEM_OWNER_UUID, id, '/absolute'));
      await assert.rejects(() => paths.resolveUser(SYSTEM_OWNER_UUID, id, '../.secrets'));
    },
  },
];

async function main(): Promise<void> {
  const prevReposRoot = process.env.REPOS_ROOT;
  // Every check resolves under an explicit tmp jail (bun test shares one
  // process across spec files — never rely on the ambient REPOS_ROOT).
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'proj-map-run-'));
  process.env.REPOS_ROOT = tmpRoot;
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
  // Restore the caller's jail (bun test shares one process across files).
  if (prevReposRoot === undefined) delete process.env.REPOS_ROOT;
  else process.env.REPOS_ROOT = prevReposRoot;
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`${failed}/${checks.length} project disk-mapping checks failed`);
    process.exitCode = 1;
  } else {
    // eslint-disable-next-line no-console
    console.log(`${checks.length}/${checks.length} project disk-mapping checks passed`);
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`project disk-mapping checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
