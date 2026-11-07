import assert from 'node:assert/strict';
import type { AppLogger } from '../../../../../../common/logger';
import { SessionHarnessService } from '../session-harness.service';

/**
 * Direct-runner lifecycle markers (ask/text-only path) — live-only parity
 * with the host/auto bus.
 *
 * The direct transport has no host tool bus, so without explicit markers a
 * direct turn would stream text with no reasoning/tool steps and the chat
 * would show a mute shimmer. The harness buffers live-only
 * `session.reasoning.started/ended` + `session.tool.called/success` frames
 * into the same bounded localFrames buffer (project-scoped via
 * data.sessionID), never durable history (recordHostEvent skips
 * reasoning/tool by type, history keeps only user + assistant text).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/sessions/__tests__/session-harness-direct-lifecycle.spec.js`
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

function wire(options: {
  calls: Array<string>;
  storedAgent?: string | undefined;
  withPaths?: boolean;
}): { service: SessionHarnessService } {
  const calls = options.calls;
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
    subscribeEvents: async (): Promise<AsyncIterable<unknown>> => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {},
    }),
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
  const args: Array<unknown> = [
    host,
    access,
    { assertServeUser() {} },
    history,
    runner,
    silentLogger(),
    agents,
    ...(paths !== undefined ? [paths] : [undefined]),
  ];
  const service = new SessionHarnessService(
    ...(args as unknown as ConstructorParameters<typeof SessionHarnessService>),
  );
  return { service };
}

function bufferedFrames(service: SessionHarnessService): Array<BufferedFrame> {
  return (service as unknown as { localFrames: Array<BufferedFrame> }).localFrames;
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: 'direct ask turn buffers reasoning + tool lifecycle around text, then idle',
    run: async () => {
      const calls: Array<string> = [];
      const { service } = wire({ calls });
      await service.sendMessage(
        UID,
        SID,
        { projectId: PID, text: 'объясни', agentId: 'ask' },
        'cid-direct-lifecycle',
      );
      const frames = bufferedFrames(service);
      const types = frames.map((frame) => frame.type);
      assert.ok(types.includes('session.reasoning.started'), `missing reasoning.started, got ${JSON.stringify(types)}`);
      assert.ok(types.includes('session.tool.called'), `missing tool.called, got ${JSON.stringify(types)}`);
      assert.ok(types.includes('session.tool.success'), `missing tool.success, got ${JSON.stringify(types)}`);
      assert.ok(types.includes('session.reasoning.ended'), `missing reasoning.ended, got ${JSON.stringify(types)}`);
      assert.ok(types.includes('session.idle'), `missing session.idle, got ${JSON.stringify(types)}`);
      // Order: lifecycle start before text, end before idle.
      const firstReasoning = types.indexOf('session.reasoning.started');
      const firstDelta = types.indexOf('message.part.delta');
      const toolSuccess = types.indexOf('session.tool.success');
      const idle = types.indexOf('session.idle');
      assert.ok(firstReasoning < firstDelta, 'reasoning.started must precede text deltas');
      assert.ok(toolSuccess < idle, 'tool.success must precede session.idle');
      // Project scope: every buffered frame carries our session uuid.
      for (const frame of frames) {
        assert.equal(frame.data.sessionID, SID);
      }
      // Tool frames carry the direct agent id (frontend activeToolName source).
      const called = frames.find((frame) => frame.type === 'session.tool.called');
      assert.equal(called?.data.tool, 'ask');
      // Durable history keeps only user + assistant text (no reasoning rows).
      const appends = calls.filter((call) => call.startsWith('history.appendMessage:'));
      assert.deepEqual(appends, ['history.appendMessage:user', 'history.appendMessage:assistant']);
    },
  },
  {
    name: 'direct file command buffers the same live-only lifecycle',
    run: async () => {
      const calls: Array<string> = [];
      const { service } = wire({ calls, withPaths: true });
      await service.sendMessage(
        UID,
        SID,
        { projectId: PID, text: 'создай файл hello.txt с текстом hi', agentId: 'ask' },
        'cid-direct-file-lifecycle',
      );
      const types = bufferedFrames(service).map((frame) => frame.type);
      assert.ok(types.includes('session.reasoning.started'));
      assert.ok(types.includes('session.tool.called'));
      assert.ok(types.includes('session.tool.success'));
      assert.ok(types.includes('session.reasoning.ended'));
      assert.ok(types.includes('session.idle'));
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
