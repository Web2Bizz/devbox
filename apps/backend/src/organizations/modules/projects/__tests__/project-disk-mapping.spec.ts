/**
 * Project disk-mapping unit checks — self-contained runner (no new deps).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/organizations/modules/projects/__tests__/project-disk-mapping.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the frozen org-only disk-first layout spec from ProjectsService
 * (no `workspace` segment, no user homes):
 * home = orgs/<orgUuid>/projects/<projectUuid>/{content,.secrets} —
 * non-uuid ids are 400-rejected, the layout is stable across renames, and
 * traversal shapes are rejected (400/403) before any disk write.
 * ownerId is audit-only and never participates in path resolution.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspacePathService } from '@common/storage/workspace-path.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'org home is deterministic per (orgId, projectId)',
    run: async () => {
      const paths = new WorkspacePathService();
      const orgId = randomUUID();
      const id = randomUUID();
      const a = await paths.resolveOrg(orgId, id);
      const b = await paths.resolveOrg(orgId, id);
      assert.equal(a.absoluteRepo, b.absoluteRepo);
      const other = await paths.resolveOrg(randomUUID(), id);
      assert.notEqual(a.absoluteRepo, other.absoluteRepo);
    },
  },
  {
    name: 'ownerId is audit-only: no owner-derived homes exist',
    run: async () => {
      const paths = new WorkspacePathService();
      const svc = (await import('../projects.service')) as Record<string, unknown>;
      assert.equal(svc.SYSTEM_OWNER_UUID, undefined);
      assert.equal(svc.ownerKeyOrThrow, undefined);
      assert.equal(
        (paths as unknown as Record<string, unknown>).resolveUser,
        undefined,
      );
    },
  },
  {
    name: 'uuid project id is a valid home under the org jail',
    run: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'proj-map-'));
      process.env.REPOS_ROOT = root;
      const paths = new WorkspacePathService();
      const orgId = randomUUID();
      const id = randomUUID();
      assert.match(id, UUID_RE);
      const resolved = await paths.resolveOrg(orgId, id);
      assert.equal(
        resolved.absoluteRepo,
        path.resolve(root, 'orgs', orgId, 'projects', id, 'content'),
      );
      assert.ok(!resolved.absoluteRepo.includes('workspace'));
      assert.ok(!resolved.absoluteBase.includes(`${path.sep}users${path.sep}`));
    },
  },
  {
    name: 'layout is stable across renames (name is display-only)',
    run: async () => {
      const paths = new WorkspacePathService();
      const orgId = randomUUID();
      const id = randomUUID();
      const before = await paths.resolveOrg(orgId, id);
      const after = await paths.resolveOrg(orgId, id);
      assert.equal(before.absoluteRepo, after.absoluteRepo);
    },
  },
  {
    name: 'non-uuid org/project ids rejected before any write (400)',
    run: async () => {
      const paths = new WorkspacePathService();
      await assert.rejects(() => paths.resolveOrg(randomUUID(), '..'));
      await assert.rejects(() => paths.resolveOrg(randomUUID(), '.'));
      await assert.rejects(() => paths.resolveOrg(randomUUID(), '../escape'));
      await assert.rejects(() => paths.resolveOrg('alice', randomUUID()));
    },
  },
  {
    name: 'nested escape via subPath rejected (403, incl. .secrets)',
    run: async () => {
      const paths = new WorkspacePathService();
      const orgId = randomUUID();
      const id = randomUUID();
      await assert.rejects(() => paths.resolveOrg(orgId, id, '../../etc'));
      await assert.rejects(() => paths.resolveOrg(orgId, id, '/absolute'));
      await assert.rejects(() => paths.resolveOrg(orgId, id, '../.secrets'));
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
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  // Restore the caller's jail (bun test shares one process across files).
  if (prevReposRoot === undefined) delete process.env.REPOS_ROOT;
  else process.env.REPOS_ROOT = prevReposRoot;
  if (failed > 0) {
    console.error(`${failed}/${checks.length} project disk-mapping checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`${checks.length}/${checks.length} project disk-mapping checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`project disk-mapping checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
