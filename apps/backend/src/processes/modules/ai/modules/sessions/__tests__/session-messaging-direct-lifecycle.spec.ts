import assert from 'node:assert/strict';
import type { AppLogger } from '@common/logger';
import { SessionsService } from '../sessions.service';
import { SessionFrameBufferService } from '../modules/events/session-frame-buffer.service';
import { SessionRuntimeStateService } from '../modules/state/session-runtime-state.service';
import { AssistantRecorderService } from '../modules/recorder/assistant-recorder.service';
import { DirectTurnService } from '../modules/messaging/direct-turn.service';
import { FileCommandTurnService } from '../modules/messaging/file-command.turn';
import { HostTurnService } from '../modules/messaging/host-turn.service';
import { SessionMessagingService } from '../modules/messaging/session-messaging.service';

/**
 * Direct-runner lifecycle (ask/text-only path) — live-only parity with the
 * host/auto bus, WITHOUT fake tool frames.
 *
 * Ask is an answer mode, NOT a tool: a plain direct turn buffers live-only
 * `session.reasoning.started/ended` + text deltas + `session.idle` and MUST
 * NOT buffer any `session.tool.*` frame (a `tool: 'ask'` frame would be a
 * fake tool call surfacing as `ask called/done` in the chat timeline).
 * The deterministic file/shell bridge is the exception: it performs a REAL
 * tool (`write`/`read`/`shell` — the registry name of the command that ran)
 * and buffers that real name, never the agent id. The readonly `read` case
 * is the ask-mode proof that real readonly tools keep their real names.
 *
 * Frames ride the shared bounded SessionFrameBufferService (project-scoped
 * via data.sessionID), never durable history (AssistantRecorderService skips
 * reasoning/tool by type, history keeps only user + assistant text).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/sessions/__tests__/session-messaging-direct-lifecycle.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 */

const UID = '123e4567-e89b-12d3-a456-426614174001';
const SID = '123e4567-e89b-12d3-a456-426614174002';
const PID = '123e4567-e89b-12d3-a456-426614174003';
const JAIL = '/tmp/repos';
const DIR = `${JAIL}/orgs/${UID}/projects/${PID}/content`;

type BufferedFrame = { id: string; type: string; data: Record<string, unknown> };

function silentLogger(): AppLogger {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as AppLogger;
}

function iterableOf(frames: Array<unknown>): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const frame of frames) yield frame;
    },
  };
}

function wire(options: {
  calls: Array<string>;
  storedAgent?: string | undefined;
  withPaths?: boolean;
}): { service: SessionsService; buffer: SessionFrameBufferService } {
  const calls = options.calls;
  const logger = silentLogger();
  const host = {
    sessionPrompt: async (): Promise<unknown> => {
      calls.push('host.sessionPrompt');
      return {
        id: 'msg_host_1',
        type: 'user',
        time: { created: Date.now() },
        payload: { text: 'hi' },
      };
    },
    sessionShell: async (): Promise<unknown> => ({ output: '' }),
    sessionInterrupt: async (): Promise<unknown> => ({ interrupted: true }),
    subscribeEvents: async (): Promise<AsyncIterable<unknown>> => iterableOf([]),
  };
  const access = {
    resolveProjectDirectory: async (projectId: string, userId: string): Promise<unknown> => {
      calls.push(`access:${projectId}:${userId}`);
      return { projectId, directory: DIR };
    },
  };
  const history = {
    async getAgent(): Promise<string | undefined> {
      return options.storedAgent ?? 'ask';
    },
    async setAgent(): Promise<void> {
      calls.push('history.setAgent');
    },
    async getHostSessionId(): Promise<string | undefined> {
      return undefined;
    },
    async appendMessage(row: { role: string }): Promise<void> {
      calls.push(`history.appendMessage:${row.role}`);
    },
    async discardMessage(): Promise<void> {
      calls.push('history.discardMessage');
    },
    async listLocalSessions(): Promise<Array<unknown>> {
      return [];
    },
    async listSessionIdsWithMessages(): Promise<Array<string>> {
      return [];
    },
    async listHostBindings(): Promise<Map<string, string>> {
      return new Map();
    },
    async findSessionByHostSessionId(): Promise<undefined> {
      return undefined;
    },
    async getAgentBySession(): Promise<undefined> {
      return undefined;
    },
  };
  const agents = {
    list: (): Array<{ id: string }> => [{ id: 'ask' }, { id: 'auto' }],
    askQuestion: async (): Promise<string> => {
      calls.push('agents.askQuestion');
      return 'direct-answer-text';
    },
  };
  const runner = {};
  const paths = options.withPaths
    ? {
        ensureDir: async (): Promise<void> => undefined,
        writeFile: async (): Promise<void> => undefined,
        readFile: async (): Promise<string> => 'file-content',
      }
    : undefined;
  const state = new SessionRuntimeStateService();
  const buffer = new SessionFrameBufferService();
  const workspace = {
    capture: async (): Promise<undefined> => undefined,
    captureBeforeTurn: async (): Promise<void> => undefined,
    recordTurnStart(): void {},
    stage: async (): Promise<unknown> => ({}),
    clear: async (): Promise<void> => undefined,
    commit: async (): Promise<void> => undefined,
    diff: async (): Promise<Array<unknown>> => [],
  };
  const hostCast = host as unknown as ConstructorParameters<typeof HostTurnService>[0];
  const historyCast = history as unknown as ConstructorParameters<typeof HostTurnService>[1];
  const workspaceCast = workspace as unknown as ConstructorParameters<typeof HostTurnService>[2];
  const recorder = new AssistantRecorderService(hostCast, historyCast, state, logger);
  const hostTurn = new HostTurnService(hostCast, historyCast, workspaceCast, state, recorder, logger);
  const directTurn = new DirectTurnService(
    historyCast,
    workspaceCast,
    state,
    buffer,
    runner as unknown as ConstructorParameters<typeof DirectTurnService>[4],
    agents as unknown as ConstructorParameters<typeof DirectTurnService>[5],
    logger,
  );
  const fileTurn = new FileCommandTurnService(
    hostCast,
    historyCast,
    workspaceCast,
    state,
    buffer,
    paths as unknown as ConstructorParameters<typeof FileCommandTurnService>[5],
    logger,
  );
  const inProcess = {
    send: async (): Promise<unknown> => ({}),
  } as unknown as ConstructorParameters<typeof SessionMessagingService>[4];
  const messaging = new SessionMessagingService(
    historyCast,
    fileTurn,
    directTurn,
    hostTurn,
    inProcess,
    runner as unknown as ConstructorParameters<typeof SessionMessagingService>[5],
    logger,
  );
  const args: Array<unknown> = [
    host,
    access,
    { assertServeUser() {} },
    history,
    { streamEvents: async (): Promise<void> => {} },
    messaging,
    { providers: async (): Promise<Array<unknown>> => [], models: async (): Promise<Array<unknown>> => [] },
    workspace,
    state,
    buffer,
    agents,
    logger,
  ];
  return {
    service: new SessionsService(...(args as unknown as ConstructorParameters<typeof SessionsService>)),
    buffer,
  };
}

function bufferedFrames(buffer: SessionFrameBufferService): Array<BufferedFrame> {
  return [...buffer.list()];
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: 'direct ask turn buffers reasoning around text, then idle — no fake ask tool frames',
    run: async () => {
      const calls: Array<string> = [];
      const { service, buffer } = wire({ calls });
      await service.sendMessage(
        UID,
        SID,
        { projectId: PID, text: 'объясни', agentId: 'ask' },
        'cid-direct-lifecycle',
      );
      const frames = bufferedFrames(buffer);
      const types = frames.map((frame) => frame.type);
      assert.ok(types.includes('session.reasoning.started'), `missing reasoning.started, got ${JSON.stringify(types)}`);
      assert.ok(types.includes('session.reasoning.ended'), `missing reasoning.ended, got ${JSON.stringify(types)}`);
      assert.ok(types.includes('session.idle'), `missing session.idle, got ${JSON.stringify(types)}`);
      assert.ok(types.includes('message.part.delta'), `missing text deltas, got ${JSON.stringify(types)}`);
      // Ask "Привет" shining path: no `ask called/done` rows — the direct
      // text path emits NO tool frames at all (neither `ask` nor any other).
      const toolFrames = frames.filter((frame) => frame.type.startsWith('session.tool.'));
      assert.deepEqual(
        toolFrames,
        [],
        `direct ask text must not buffer tool frames, got ${JSON.stringify(toolFrames.map((frame) => ({ type: frame.type, data: frame.data })))}`,
      );
      // Order: reasoning start before text, reasoning end before idle.
      const firstReasoning = types.indexOf('session.reasoning.started');
      const firstDelta = types.indexOf('message.part.delta');
      const reasoningEnded = types.indexOf('session.reasoning.ended');
      const idle = types.indexOf('session.idle');
      assert.ok(firstReasoning < firstDelta, 'reasoning.started must precede text deltas');
      assert.ok(reasoningEnded < idle, 'reasoning.ended must precede session.idle');
      // Project scope: every buffered frame carries our session uuid.
      for (const frame of frames) {
        assert.equal(frame.data.sessionID, SID);
      }
      // Durable history keeps only user + assistant text (no reasoning rows).
      const appends = calls.filter((call) => call.startsWith('history.appendMessage:'));
      assert.deepEqual(appends, ['history.appendMessage:user', 'history.appendMessage:assistant']);
    },
  },
  {
    name: 'direct file command buffers the REAL write tool (never ask)',
    run: async () => {
      const calls: Array<string> = [];
      const { service, buffer } = wire({ calls, withPaths: true });
      await service.sendMessage(
        UID,
        SID,
        { projectId: PID, text: 'создай файл hello.txt с текстом hi', agentId: 'ask' },
        'cid-direct-file-lifecycle',
      );
      const frames = bufferedFrames(buffer);
      const types = frames.map((frame) => frame.type);
      assert.ok(types.includes('session.reasoning.started'));
      assert.ok(types.includes('session.tool.called'));
      assert.ok(types.includes('session.tool.success'));
      assert.ok(types.includes('session.reasoning.ended'));
      assert.ok(types.includes('session.idle'));
      const called = frames.find((frame) => frame.type === 'session.tool.called');
      const succeeded = frames.find((frame) => frame.type === 'session.tool.success');
      assert.equal(called?.data.tool, 'write');
      assert.equal(succeeded?.data.tool, 'write');
      // No fake agent-id tool frame anywhere on the turn.
      for (const frame of frames) {
        if (frame.type.startsWith('session.tool.')) {
          assert.notEqual(frame.data.tool, 'ask', 'file turn must not emit a fake ask tool frame');
        }
      }
    },
  },
  {
    name: 'direct file read buffers the REAL readonly read tool (never ask)',
    run: async () => {
      const calls: Array<string> = [];
      const { service, buffer } = wire({ calls, withPaths: true });
      await service.sendMessage(
        UID,
        SID,
        { projectId: PID, text: 'прочитай файл hello.txt', agentId: 'ask' },
        'cid-direct-file-read-lifecycle',
      );
      const frames = bufferedFrames(buffer);
      const called = frames.find((frame) => frame.type === 'session.tool.called');
      const succeeded = frames.find((frame) => frame.type === 'session.tool.success');
      assert.equal(called?.data.tool, 'read');
      assert.equal(succeeded?.data.tool, 'read');
      for (const frame of frames) {
        if (frame.type.startsWith('session.tool.')) {
          assert.notEqual(frame.data.tool, 'ask', 'read turn must not emit a fake ask tool frame');
        }
      }
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} direct lifecycle checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} direct lifecycle checks failed`);
  }
  console.log(`${checks.length}/${checks.length} direct lifecycle checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`direct lifecycle checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
