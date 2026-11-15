import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import type { AppLogger } from '@common/logger';
import type { WorkspacePathService } from '@common/storage/workspace-path.service';
import type { OpencodeHostService } from '../../../../opencode/opencode-host.service';
import type { SessionHistoryRepository } from '../../../session-history.repository';
import type { SendMessageInput } from '../../../sessions.dto';
import { SessionFrameBufferService } from '../../events/session-frame-buffer.service';
import { SessionRuntimeStateService } from '../../state/session-runtime-state.service';
import type { TurnWorkspaceService } from '../../workspace/turn-workspace.service';
import { FileCommandTurnService } from '../file-command.turn';

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

function body(text: string): SendMessageInput {
  return { projectId: '00000000-0000-7000-8000-000000000001', text };
}

type Recorded = {
  setAgent: Array<{ sessionId: string; projectId: string; agentId: string }>;
  appended: Array<{ role: 'user' | 'assistant' | 'tool'; text: string | null; kind?: string; name?: string }>;
  turns: Array<{ sessionId: string; messageID: string }>;
};

type HarnessOptions = {
  paths?: boolean;
  readContent?: string;
  shellOutput?: unknown;
};

function makeHarness(options: HarnessOptions = {}): {
  service: FileCommandTurnService;
  recorded: Recorded;
  writes: Array<{ absolutePath: string; content: string }>;
  dirs: Array<string>;
  shellCalls: Array<{ directory: string; command: string }>;
  state: SessionRuntimeStateService;
  buffer: SessionFrameBufferService;
} {
  const { logger } = recordingLogger();
  const recorded: Recorded = { setAgent: [], appended: [], turns: [] };
  const history = {
    setAgent: async (sessionId: string, projectId: string, agentId: string) => {
      recorded.setAgent.push({ sessionId, projectId, agentId });
    },
    appendMessage: async (row: { role: 'user' | 'assistant' | 'tool'; text: string | null; kind?: string; name?: string }) => {
      recorded.appended.push({ role: row.role, text: row.text, kind: row.kind, name: row.name });
    },
  } as unknown as SessionHistoryRepository;

  const writes: Array<{ absolutePath: string; content: string }> = [];
  const dirs: Array<string> = [];
  const paths =
    options.paths === false
      ? undefined
      : ({
          ensureDir: async (absolutePath: string) => {
            dirs.push(absolutePath);
          },
          writeFile: async (absolutePath: string, content: string) => {
            writes.push({ absolutePath, content });
          },
          readFile: async (_abs: string) => options.readContent ?? '',
        } as unknown as WorkspacePathService);

  const shellCalls: Array<{ directory: string; command: string }> = [];
  const host = {
    sessionShell: async (directory: string, command: string) => {
      shellCalls.push({ directory, command });
      return options.shellOutput ?? { output: 'hi' };
    },
  } as unknown as OpencodeHostService;

  const workspace = {
    captureBeforeTurn: async (_directory: string, sessionId: string, messageID: string) => {
      recorded.turns.push({ sessionId, messageID });
    },
  } as unknown as TurnWorkspaceService;

  const state = new SessionRuntimeStateService();
  const buffer = new SessionFrameBufferService();
  const service = new FileCommandTurnService(host, history, workspace, state, buffer, paths, logger);
  return { service, recorded, writes, dirs, shellCalls, state, buffer };
}

describe('FileCommandTurnService', () => {
  it('a traversal escape answers 403 with no durable writes', async () => {
    const { service, recorded, writes, state, buffer } = makeHarness();
    await assert.rejects(
      service.tryHandle({
        userId: 'u1',
        sessionId: 's1',
        body: body('создай файл ../evil.txt с текстом pwn'),
        directory: '/repo',
        agentId: 'ask',
        correlationId: 'cid-1',
      }),
      (err: unknown) => err instanceof ForbiddenException,
    );
    assert.equal(recorded.setAgent.length, 0);
    assert.equal(recorded.appended.length, 0);
    assert.equal(recorded.turns.length, 0);
    assert.equal(writes.length, 0);
    assert.equal(state.isBusy('s1'), false);
    // Jail rejects before the turn starts: no lifecycle frames at all.
    assert.deepEqual(buffer.list(), []);
  });

  it('create writes through the jailed paths and answers the user receipt', async () => {
    const { service, recorded, writes, dirs, state, buffer } = makeHarness();
    const result = await service.tryHandle({
      userId: 'u1',
      sessionId: 's1',
      body: body('создай файл notes/a.txt с текстом hello'),
      directory: '/repo',
      agentId: 'ask',
      correlationId: 'cid-1',
    });
    assert.equal(result?.type, 'user');
    assert.equal(result?.text, 'создай файл notes/a.txt с текстом hello');
    assert.deepEqual(writes, [{ absolutePath: '/repo/notes/a.txt', content: 'hello' }]);
    assert.deepEqual(dirs, ['/repo/notes']);
    assert.deepEqual(
      recorded.appended.map((row) => row.role),
      ['user', 'tool', 'assistant'],
    );
    assert.equal(recorded.appended[2]?.text, 'Файл notes/a.txt создан.');
    assert.equal(state.isBusy('s1'), false);
    assert.ok(buffer.list().some((frame) => frame.type === 'session.idle'));
    assert.ok(buffer.list().some((frame) => frame.type === 'message.part.updated'));
    // Real deterministic tool with its registry name — never a fake `ask` frame.
    const called = buffer.list().find((frame) => frame.type === 'session.tool.called');
    const succeeded = buffer.list().find((frame) => frame.type === 'session.tool.success');
    assert.equal(called?.data.tool, 'write');
    assert.equal(succeeded?.data.tool, 'write');
    for (const frame of buffer.list()) {
      if (frame.type.startsWith('session.tool.')) {
        assert.notEqual(frame.data.tool, 'ask');
      }
    }
  });

  it('read echoes the jailed file content in the assistant row', async () => {
    const { service, recorded, buffer } = makeHarness({ readContent: 'file body' });
    const result = await service.tryHandle({
      userId: 'u1',
      sessionId: 's1',
      body: body('прочитай файл a.txt'),
      directory: '/repo',
      agentId: 'ask',
      correlationId: 'cid-1',
    });
    assert.equal(result?.type, 'user');
    assert.equal(recorded.appended[2]?.text, 'file body');
    // Readonly real tool keeps its real name end-to-end (ask-mode proof).
    const called = buffer.list().find((frame) => frame.type === 'session.tool.called');
    const succeeded = buffer.list().find((frame) => frame.type === 'session.tool.success');
    assert.equal(called?.data.tool, 'read');
    assert.equal(succeeded?.data.tool, 'read');
  });

  it('shell runs through the host in the same jail', async () => {
    const { service, recorded, shellCalls, buffer } = makeHarness({ shellOutput: { output: 'hi\n' } });
    const result = await service.tryHandle({
      userId: 'u1',
      sessionId: 's1',
      body: body('выполни echo hi'),
      directory: '/repo',
      agentId: 'ask',
      correlationId: 'cid-1',
    });
    assert.equal(result?.type, 'user');
    assert.deepEqual(shellCalls, [{ directory: '/repo', command: 'echo hi' }]);
    assert.equal(recorded.appended[2]?.text, 'hi\n');
    const called = buffer.list().find((frame) => frame.type === 'session.tool.called');
    const succeeded = buffer.list().find((frame) => frame.type === 'session.tool.success');
    assert.equal(called?.data.tool, 'shell');
    assert.equal(succeeded?.data.tool, 'shell');
  });

  it('without the jail primitives the turn is not claimed', async () => {
    const { service, recorded } = makeHarness({ paths: false });
    const result = await service.tryHandle({
      userId: 'u1',
      sessionId: 's1',
      body: body('создай файл a.txt'),
      directory: '/repo',
      agentId: 'ask',
      correlationId: 'cid-1',
    });
    assert.equal(result, null);
    assert.equal(recorded.setAgent.length, 0);
    assert.equal(recorded.appended.length, 0);
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
  console.error(`file command checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
