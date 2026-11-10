import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ExternalServiceError } from '@common/external/external-error';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { parseUnifiedDiff, SnapshotsService } from '../snapshots.service';

const exec = promisify(execFile);

type Case = { name: string; run: () => Promise<void> | void };
const cases: Array<Case> = [];
let suite = '';

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = '';
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

async function git(cwd: string, ...args: Array<string>): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args]);
  return stdout;
}

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'snapshots-spec-'));
  await git(dir, 'init', '-q');
  return dir;
}

function service(): SnapshotsService {
  return new SnapshotsService(new WorkspacePathService());
}

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1 +1 @@',
  '-one',
  '+two',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('reads the file path and keeps the hunk body', () => {
    const rows = parseUnifiedDiff(PATCH);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.file, 'a.txt');
    assert.match(rows[0]?.hunks ?? '', /\+two/);
  });

  it('answers an empty list for empty output', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
  });
});

describe('SnapshotsService', () => {
  it('captures, diffs and restores selected paths (absent path removed)', async () => {
    const dir = await tempRepo();
    try {
      await writeFile(path.join(dir, 'a.txt'), 'one\n');
      const svc = service();
      const from = await svc.capture(dir);
      assert.ok(from, 'capture must return a tree id inside a git worktree');

      await writeFile(path.join(dir, 'a.txt'), 'two\n');
      await writeFile(path.join(dir, 'b.txt'), 'new\n');
      const to = await svc.capture(dir);
      assert.ok(to);

      const changed = await svc.files(dir, from, to);
      assert.deepEqual(changed.sort(), ['a.txt', 'b.txt']);

      const rows = await svc.diff(dir, from, to);
      assert.deepEqual(
        rows.map((row) => row.file).sort(),
        ['a.txt', 'b.txt'],
      );

      await svc.restore(dir, [
        { path: 'a.txt', snapshot: from },
        { path: 'b.txt', snapshot: from },
      ]);
      assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\n');
      await assert.rejects(readFile(path.join(dir, 'b.txt'), 'utf8'), /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures nothing outside a git worktree (best-effort undefined)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'snapshots-spec-'));
    try {
      assert.equal(await service().capture(dir), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses restore outside a git worktree with EXTERNAL_UNAVAILABLE', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'snapshots-spec-'));
    try {
      await assert.rejects(
        service().restore(dir, [{ path: 'a.txt', snapshot: 'a'.repeat(40) }]),
        (err: unknown) => err instanceof ExternalServiceError && err.code === 'EXTERNAL_UNAVAILABLE',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`snapshots checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
