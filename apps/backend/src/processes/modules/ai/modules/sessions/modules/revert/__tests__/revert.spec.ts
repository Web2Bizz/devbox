import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NotFoundException } from '@nestjs/common';
import { WorkspacePathService } from '../../../../../../../../common/storage/workspace-path.service';
import type { SessionHistoryRepository } from '../../../session-history.repository';
import { RevertService } from '../revert.service';
import { SnapshotsService } from '../../snapshots/snapshots.service';

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

const MESSAGES = [
  { id: 'msg-user-1', type: 'user', createdAt: '2026-01-01T00:00:00.000Z', text: 'do it' },
  { id: 'msg-assistant-1', type: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', text: 'done' },
];

function serviceWith(history: { listMessages: () => Promise<Array<(typeof MESSAGES)[number]>> }): {
  revert: RevertService;
  snapshots: SnapshotsService;
} {
  const snapshots = new SnapshotsService(new WorkspacePathService());
  const revert = new RevertService(
    history as unknown as SessionHistoryRepository,
    snapshots,
  );
  return { revert, snapshots };
}

describe('RevertService', () => {
  it('stages the pre-turn tree, restores files and clear() returns them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'revert-spec-'));
    try {
      await git(dir, 'init', '-q');
      await writeFile(path.join(dir, 'a.txt'), 'one\n');
      const { revert, snapshots } = serviceWith({
        listMessages: async () => MESSAGES,
      });
      const preTurn = await snapshots.capture(dir);
      assert.ok(preTurn);
      revert.recordTurnStart('session-1', 'msg-user-1', preTurn);

      // The turn mutates the tree.
      await writeFile(path.join(dir, 'a.txt'), 'two\n');
      await writeFile(path.join(dir, 'b.txt'), 'new\n');

      const info = await revert.stage({
        sessionId: 'session-1',
        directory: dir,
        messageID: 'msg-assistant-1',
      });
      assert.equal(info.snapshot, preTurn);
      assert.deepEqual(
        info.files.map((file) => file.file).sort(),
        ['a.txt', 'b.txt'],
      );
      assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\n');
      await assert.rejects(readFile(path.join(dir, 'b.txt'), 'utf8'), /ENOENT/);

      await revert.clear('session-1');
      assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
      assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), 'new\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('commit keeps the restored files and drops the staged state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'revert-spec-'));
    try {
      await git(dir, 'init', '-q');
      await writeFile(path.join(dir, 'a.txt'), 'one\n');
      const { revert, snapshots } = serviceWith({
        listMessages: async () => MESSAGES,
      });
      const preTurn = await snapshots.capture(dir);
      assert.ok(preTurn);
      revert.recordTurnStart('session-2', 'msg-user-1', preTurn);
      await writeFile(path.join(dir, 'a.txt'), 'two\n');

      await revert.stage({
        sessionId: 'session-2',
        directory: dir,
        messageID: 'msg-assistant-1',
      });
      await revert.commit('session-2');
      assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers an honest empty stage when the turn has no snapshot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'revert-spec-'));
    try {
      const { revert } = serviceWith({ listMessages: async () => MESSAGES });
      const info = await revert.stage({
        sessionId: 'session-3',
        directory: dir,
        messageID: 'msg-user-1',
      });
      assert.deepEqual(info, { messageID: 'msg-user-1', snapshot: null, files: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers MessageNotFound for an unknown boundary message', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'revert-spec-'));
    try {
      const { revert } = serviceWith({ listMessages: async () => MESSAGES });
      await assert.rejects(
        revert.stage({ sessionId: 'session-4', directory: dir, messageID: 'missing' }),
        (err: unknown) => err instanceof NotFoundException,
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
  console.error(`revert checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
