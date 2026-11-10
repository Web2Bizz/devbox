import assert from 'node:assert/strict';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import type { AppLogger } from '@common/logger';
import { SessionsService } from '../sessions.service';
import { SessionFrameBufferService } from '../modules/events/session-frame-buffer.service';
import { SessionRuntimeStateService } from '../modules/state/session-runtime-state.service';
import { AssistantRecorderService } from '../modules/recorder/assistant-recorder.service';
import { DirectTurnService } from '../modules/messaging/direct-turn.service';
import { FileCommandTurnService } from '../modules/messaging/file-command.turn';
import { HostTurnService } from '../modules/messaging/host-turn.service';
import { InProcessTurnService } from '../modules/messaging/in-process-turn.service';
import { SessionMessagingService } from '../modules/messaging/session-messaging.service';

/**
 * D1 auto transport gate — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/sessions/__tests__/session-messaging-auto-host.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: auto→in-process (host never prompted), ask→direct unchanged, stored
 * auto (body.agentId undefined + history auto) → in-process, auto without a
 * key → honest 404 (no host fallback), unknown agent 404, traversal 403 via
 * the file-command jail, explicit-vs-stored precedence, default-ask fallback,
 * file-command precedence over auto, in-process-error propagation, hostile
 * agentId type, huge text, repeat safety, interrupt idle/busy paths.
 *
 * Assembly is the real sessions domain: SessionsService + SessionMessaging
 * + Direct/Host/FileCommand turns, with hand-wired fakes for host/history/
 * agents/paths/state/buffer/workspace and the in-process turn.
 */

const UID = '123e4567-e89b-12d3-a456-426614174001';
const SID = '123e4567-e89b-12d3-a456-426614174002';
const PID = '123e4567-e89b-12d3-a456-426614174003';
const JAIL = '/tmp/repos';
const DIR = `${JAIL}/orgs/${UID}/projects/${PID}/content`;

type LogEntry = { level: string; message: string };

function silentLogger(entries: Array<LogEntry>): AppLogger {
  const record = (level: string) => (message: unknown): void => {
    entries.push({ level, message: String(message) });
  };
  return {
    debug: record('debug'),
    info: record('info'),
    log: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
  } as unknown as AppLogger;
}

function iterableOf(frames: Array<unknown>): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const frame of frames) yield frame;
    },
  };
}

type Wired = {
  svc: SessionsService;
  state: SessionRuntimeStateService;
  buffer: SessionFrameBufferService;
};

function wire(options: {
  entries: Array<LogEntry>;
  calls: Array<string>;
  storedAgent?: string | undefined;
  withPaths?: boolean;
  hostSessionId?: string | null;
  promptError?: unknown;
  inProcessError?: unknown;
  interruptResult?: { interrupted: boolean };
  interruptError?: unknown;
}): Wired {
  const logger = silentLogger(options.entries);
  const host = {
    sessionPrompt: async (sessionID: string, text: string): Promise<unknown> => {
      options.calls.push(`host.sessionPrompt:${sessionID}:${text}`);
      if (options.promptError !== undefined) throw options.promptError;
      return {
        id: 'msg_host_1',
        type: 'user',
        time: { created: Date.now() },
        payload: { text },
      };
    },
    sessionShell: async (): Promise<unknown> => {
      options.calls.push('host.sessionShell');
      return { output: '' };
    },
    sessionInterrupt: async (sessionID: string): Promise<unknown> => {
      options.calls.push(`host.sessionInterrupt:${sessionID}`);
      if (options.interruptError !== undefined) throw options.interruptError;
      return options.interruptResult ?? { interrupted: true };
    },
    subscribeEvents: async (): Promise<AsyncIterable<unknown>> => {
      options.calls.push('host.subscribeEvents');
      return iterableOf([]);
    },
  };
  const access = {
    resolveProjectDirectory: async (projectId: string, userId: string): Promise<unknown> => {
      options.calls.push(`access:${projectId}:${userId}`);
      return { projectId, directory: DIR };
    },
  };
  const history = {
    async getAgent(): Promise<string | undefined> {
      return options.storedAgent;
    },
    async setAgent(): Promise<void> {
      options.calls.push('history.setAgent');
    },
    async getHostSessionId(): Promise<string | undefined> {
      if (options.hostSessionId === null) return undefined;
      return options.hostSessionId ?? 'ses_host_1';
    },
    async appendMessage(): Promise<void> {
      options.calls.push('history.appendMessage');
    },
    async discardMessage(): Promise<void> {
      options.calls.push('history.discardMessage');
    },
  };
  const agents = {
    list: (): Array<{ id: string }> => [{ id: 'ask' }, { id: 'auto' }],
    askQuestion: async (): Promise<string> => {
      options.calls.push('agents.askQuestion');
      return 'direct-answer';
    },
  };
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
  const runner = {};
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
    send: async (input: { agentId: string; body: { text: string } }): Promise<unknown> => {
      options.calls.push(`inProcess.send:${input.agentId}:${input.body.text}`);
      if (options.inProcessError !== undefined) throw options.inProcessError;
      return {
        id: 'msg_local_1',
        type: 'user',
        createdAt: new Date().toISOString(),
        text: input.body.text,
      };
    },
  } as unknown as InProcessTurnService;
  const messaging = new SessionMessagingService(
    historyCast,
    fileTurn,
    directTurn,
    hostTurn,
    inProcess,
    runner as unknown as ConstructorParameters<typeof SessionMessagingService>[5],
    logger,
  );
  const stream = { streamEvents: async (): Promise<void> => {} };
  const inventory = {
    providers: async (): Promise<Array<unknown>> => [],
    models: async (): Promise<Array<unknown>> => [],
  };
  const args: Array<unknown> = [
    host,
    access,
    { assertServeUser() {} },
    history,
    stream,
    messaging,
    inventory,
    workspace,
    state,
    buffer,
    agents,
    logger,
  ];
  return {
    svc: new SessionsService(...(args as unknown as ConstructorParameters<typeof SessionsService>)),
    state,
    buffer,
  };
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: 'auto body.agentId → in-process (host never prompted)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'напиши Hello World на NodeJS', agentId: 'auto' }, 'cid-auto');
      assert.ok(
        calls.some((c) => c.startsWith('inProcess.send:auto:')),
        `inProcess.send must own the auto turn, got ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.includes('agents.askQuestion'),
        'the direct runner path must not run for auto',
      );
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(entries.some((e) => e.message === '[sessions] auto in-process'));
    },
  },
  {
    name: 'stored auto (no body.agentId) → in-process via history fallback',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, storedAgent: 'auto' });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'напиши Hello World на NodeJS' }, 'cid-stored');
      assert.ok(calls.some((c) => c.startsWith('inProcess.send:auto:')));
      assert.ok(!calls.includes('agents.askQuestion'));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(entries.some((e) => e.message === '[sessions] auto in-process'));
    },
  },
  {
    name: 'ask → direct unchanged (no host prompt, no auto log)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, storedAgent: 'ask' });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'объясни что такое Hello World', agentId: 'ask' }, 'cid-ask');
      assert.ok(calls.includes('agents.askQuestion'), `direct must answer ask, got ${JSON.stringify(calls)}`);
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!entries.some((e) => e.message === '[sessions] auto in-process'));
    },
  },
  {
    name: 'unknown agent → honest 404 before any transport',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls });
      await assert.rejects(
        svc.sendMessage(UID, SID, { projectId: PID, text: 'hi', agentId: 'nope' }, 'cid-404'),
        (err: unknown) => err instanceof NotFoundException,
      );
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!calls.includes('agents.askQuestion'));
    },
  },
  {
    name: 'traversal file command → 403 with no durable side effects',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, withPaths: true });
      await assert.rejects(
        svc.sendMessage(
          UID,
          SID,
          { projectId: PID, text: 'создай файл ../escape.txt с текстом hi', agentId: 'ask' },
          'cid-403',
        ),
        (err: unknown) => err instanceof ForbiddenException,
      );
      assert.ok(!calls.includes('history.appendMessage'));
    },
  },
  {
    name: 'explicit auto wins over stored ask → in-process',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, storedAgent: 'ask' });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'сделай задачу', agentId: 'auto' }, 'cid-exp-auto');
      assert.ok(calls.some((c) => c.startsWith('inProcess.send:auto:')));
      assert.ok(!calls.includes('agents.askQuestion'));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(entries.some((e) => e.message === '[sessions] auto in-process'));
    },
  },
  {
    name: 'explicit ask wins over stored auto → direct',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, storedAgent: 'auto' });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'объясни', agentId: 'ask' }, 'cid-exp-ask');
      assert.ok(calls.includes('agents.askQuestion'));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!calls.some((c) => c.startsWith('inProcess.send:')));
    },
  },
  {
    name: 'no agent anywhere defaults to ask → direct (never host)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, storedAgent: undefined });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'привет' }, 'cid-default');
      assert.ok(calls.includes('agents.askQuestion'));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
    },
  },
  {
    name: 'auto file command stays jailed (no in-process / host prompt)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, withPaths: true });
      const res = await svc.sendMessage(
        UID,
        SID,
        { projectId: PID, text: 'создай файл hello.js с текстом console.log("hi")', agentId: 'auto' },
        'cid-auto-file',
      );
      assert.equal(res.type, 'user');
      assert.ok(!calls.some((c) => c.startsWith('inProcess.send:')));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(calls.includes('history.appendMessage'));
    },
  },
  {
    name: 'auto traversal → 403 before any in-process / host prompt',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, withPaths: true });
      await assert.rejects(
        svc.sendMessage(
          UID,
          SID,
          { projectId: PID, text: 'создай файл ../escape.txt с текстом hi', agentId: 'auto' },
          'cid-auto-403',
        ),
        (err: unknown) => err instanceof ForbiddenException,
      );
      assert.ok(!calls.some((c) => c.startsWith('inProcess.send:')));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!calls.includes('history.appendMessage'));
    },
  },
  {
    name: 'auto without a key → honest 404, host never prompted',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const missing = new NotFoundException({
        code: 'opencode_key_missing',
        message: 'No OpenCode API key configured for this user',
      });
      const { svc } = wire({ entries, calls, inProcessError: missing });
      await assert.rejects(
        svc.sendMessage(UID, SID, { projectId: PID, text: 'сделай', agentId: 'auto' }, 'cid-nokey'),
        (err: unknown) => {
          if (!(err instanceof NotFoundException)) return false;
          const res = err.getResponse() as { code?: string };
          return typeof res === 'object' && res !== null && res.code === 'opencode_key_missing';
        },
      );
      assert.ok(calls.some((c) => c.startsWith('inProcess.send:auto:')));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
    },
  },
  {
    name: 'in-process failure propagates (no swallow, no fake answer)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, inProcessError: new Error('model-down') });
      await assert.rejects(
        svc.sendMessage(UID, SID, { projectId: PID, text: 'сделай', agentId: 'auto' }, 'cid-inproc-fail'),
        (err: unknown) => err instanceof Error && (err as Error).message === 'model-down',
      );
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
    },
  },
  {
    name: 'invalid agentId type → honest 404 before any transport',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls });
      await assert.rejects(
        svc.sendMessage(
          UID,
          SID,
          { projectId: PID, text: 'hi', agentId: 123 as unknown as string },
          'cid-badtype',
        ),
        (err: unknown) => err instanceof NotFoundException,
      );
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!calls.includes('agents.askQuestion'));
    },
  },
  {
    name: 'huge auto text still goes in-process (no truncation/crash)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls });
      const big = `сделай ${'x'.repeat(100_000)}`;
      await svc.sendMessage(UID, SID, { projectId: PID, text: big, agentId: 'auto' }, 'cid-huge');
      assert.ok(calls.some((c) => c.startsWith('inProcess.send:auto:')));
      assert.ok(entries.some((e) => e.message === '[sessions] auto in-process'));
    },
  },
  {
    name: 'repeat auto prompt is idempotent-safe (two in-process turns)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls });
      const body = { projectId: PID, text: 'напиши Hello World на NodeJS', agentId: 'auto' as const };
      await svc.sendMessage(UID, SID, body, 'cid-repeat-1');
      await svc.sendMessage(UID, SID, body, 'cid-repeat-2');
      const inProcessCalls = calls.filter((c) => c.startsWith('inProcess.send:'));
      assert.equal(inProcessCalls.length, 2);
      assert.ok(!calls.includes('agents.askQuestion'));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
    },
  },
  {
    name: 'interrupt idle unbound → honest 404',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, hostSessionId: null });
      await assert.rejects(
        svc.interrupt(UID, SID, { projectId: PID }, 'cid-int-404'),
        (err: unknown) => err instanceof NotFoundException,
      );
    },
  },
  {
    name: 'interrupt busy local + host false → interrupted true (OR)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc, state, buffer } = wire({ entries, calls, interruptResult: { interrupted: false } });
      state.markBusy(SID);
      const res = await svc.interrupt(UID, SID, { projectId: PID }, 'cid-int-or');
      assert.equal(res.interrupted, true);
      assert.ok(calls.some((c) => c.startsWith('host.sessionInterrupt:')));
      assert.equal(state.isBusy(SID), false, 'a local interrupt clears the busy marker');
      const idle = buffer.list().filter((frame) => frame.type === 'session.idle');
      assert.equal(idle.length, 1, 'a local interrupt buffers one terminal session.idle');
      assert.equal(idle[0]?.data.sessionID, SID);
    },
  },
  {
    name: 'interrupt idle bound delegates to host answer',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const { svc } = wire({ entries, calls, interruptResult: { interrupted: false } });
      const res = await svc.interrupt(UID, SID, { projectId: PID }, 'cid-int-idle');
      assert.equal(res.interrupted, false);
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
    console.error(`${failed}/${checks.length} auto-host gate checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} auto-host gate checks failed`);
  }
  console.log(`${checks.length}/${checks.length} auto-host gate checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`auto-host gate checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
