import assert from 'node:assert/strict';
import type { AppLogger } from '@common/logger';
import type { SnapshotDiff } from '../../../sessions.dto';
import type { RevertService, RevertStageCommand } from '../../revert/revert.service';
import type { SnapshotsService } from '../../snapshots/snapshots.service';
import { TurnWorkspaceService } from '../turn-workspace.service';

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

function recordingLogger(): { logger: AppLogger; warns: Array<string>; infos: Array<string> } {
  const warns: Array<string> = [];
  const infos: Array<string> = [];
  const logger = {
    debug() {},
    info(message: unknown) {
      infos.push(String(message));
    },
    log() {},
    warn(message: unknown) {
      warns.push(String(message));
    },
    error() {},
    fatal() {},
  } as unknown as AppLogger;
  return { logger, warns, infos };
}

describe('TurnWorkspaceService', () => {
  it('capture is best-effort: a throwing snapshot returns undefined + warn', async () => {
    const { logger, warns } = recordingLogger();
    const snapshots = {
      capture: async (_directory: string): Promise<string | undefined> => {
        throw new Error('boom');
      },
    } as unknown as SnapshotsService;
    const workspace = new TurnWorkspaceService(snapshots, undefined, logger);
    const tree = await workspace.capture('/repo', 'cid-1');
    assert.equal(tree, undefined);
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? '', /snapshot skipped/);
  });

  it('captureBeforeTurn records the captured tree by receipt id', async () => {
    const { logger } = recordingLogger();
    const snapshots = {
      capture: async (_directory: string): Promise<string | undefined> => 'tree-1',
    } as unknown as SnapshotsService;
    const recordCalls: Array<{ sessionId: string; messageID: string; snapshot?: string }> = [];
    const revert = {
      recordTurnStart: (sessionId: string, messageID: string, snapshot?: string) => {
        recordCalls.push({ sessionId, messageID, ...(snapshot !== undefined ? { snapshot } : {}) });
      },
    } as unknown as RevertService;
    const workspace = new TurnWorkspaceService(snapshots, revert, logger);
    await workspace.captureBeforeTurn('/repo', 's1', 'm1', 'cid-1');
    assert.deepEqual(recordCalls, [{ sessionId: 's1', messageID: 'm1', snapshot: 'tree-1' }]);
  });

  it('stage/clear/commit/diff delegate and forward their arguments', async () => {
    const { logger } = recordingLogger();
    const stageCalls: Array<RevertStageCommand> = [];
    const clearCalls: Array<string> = [];
    const commitCalls: Array<string> = [];
    const revert = {
      stage: async (command: RevertStageCommand) => {
        stageCalls.push(command);
        return { messageID: command.messageID, snapshot: 'tree-1', files: [] };
      },
      clear: async (sessionId: string) => {
        clearCalls.push(sessionId);
      },
      commit: async (sessionId: string) => {
        commitCalls.push(sessionId);
      },
    } as unknown as RevertService;
    const diffs: Array<SnapshotDiff> = [{ file: 'a.txt', hunks: '@@ -1 +1 @@' }];
    const diffCalls: Array<{
      directory: string;
      from: string;
      to: string;
      context: number | undefined;
    }> = [];
    const snapshots = {
      diff: async (
        directory: string,
        from: string,
        to: string,
        context?: number,
      ): Promise<Array<SnapshotDiff>> => {
        diffCalls.push({ directory, from, to, context });
        return diffs;
      },
    } as unknown as SnapshotsService;
    const workspace = new TurnWorkspaceService(snapshots, revert, logger);

    const info = await workspace.stage(
      { sessionId: 's1', directory: '/repo', messageID: 'm1', files: ['a.txt'] },
      'cid-1',
    );
    assert.equal(info.snapshot, 'tree-1');
    assert.deepEqual(stageCalls, [
      { sessionId: 's1', directory: '/repo', messageID: 'm1', files: ['a.txt'] },
    ]);

    await workspace.clear('s1', 'cid-1');
    await workspace.commit('s1', 'cid-1');
    assert.deepEqual(clearCalls, ['s1']);
    assert.deepEqual(commitCalls, ['s1']);

    const from = 'a'.repeat(40);
    const to = 'b'.repeat(40);
    const rows = await workspace.diff('/repo', from, to, 5, 'cid-1');
    assert.equal(rows, diffs);
    assert.deepEqual(diffCalls, [{ directory: '/repo', from, to, context: 5 }]);
  });

  it('answers honest Errors when the git services are not wired', async () => {
    const workspace = new TurnWorkspaceService();
    assert.equal(await workspace.capture('/repo', 'cid-1'), undefined);
    await workspace.captureBeforeTurn('/repo', 's1', 'm1', 'cid-1');
    workspace.recordTurnStart('s1', 'm1', 'tree-1');
    await assert.rejects(
      workspace.stage({ sessionId: 's1', directory: '/repo', messageID: 'm1' }, 'cid-1'),
      /RevertService is not wired/,
    );
    await assert.rejects(workspace.clear('s1', 'cid-1'), /RevertService is not wired/);
    await assert.rejects(workspace.commit('s1', 'cid-1'), /RevertService is not wired/);
    await assert.rejects(
      workspace.diff('/repo', 'a'.repeat(40), 'b'.repeat(40), undefined, 'cid-1'),
      /SnapshotsService is not wired/,
    );
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
  console.error(`turn workspace checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
