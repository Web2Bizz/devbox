import assert from 'node:assert/strict';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import type { AppLogger } from '../../../../../../common/logger';
import { SessionHarnessService } from '../session-harness.service';

/**
 * CARD-3 auto→host gate — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/sessions/__tests__/session-harness-auto-host.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: auto→host even when a runner key exists, ask→direct unchanged,
 * stored auto (body.agentId undefined + history auto) → host, unknown agent
 * 404, traversal 403 via the file-command jail, explicit-vs-stored precedence,
 * default-ask fallback, file-command precedence over auto, unbound 404,
 * host-error propagation, hostile agentId type, huge text, repeat safety,
 * interrupt idle/busy paths.
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

function wire(options: {
  entries: Array<LogEntry>;
  calls: Array<string>;
  storedAgent?: string | undefined;
  withPaths?: boolean;
  hostSessionId?: string | null;
  promptError?: unknown;
  interruptResult?: { interrupted: boolean };
  interruptError?: unknown;
}): SessionHarnessService {
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
  const args: Array<unknown> = [
    host,
    access,
    { assertServeUser() {} },
    history,
    {},
    silentLogger(options.entries),
    agents,
    ...(paths !== undefined ? [paths] : [undefined]),
  ];
  return new SessionHarnessService(
    ...(args as unknown as ConstructorParameters<typeof SessionHarnessService>),
  );
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: 'auto body.agentId → host even when the runner key exists',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'напиши Hello World на NodeJS', agentId: 'auto' }, 'cid-auto');
      assert.ok(
        calls.some((c) => c.startsWith('host.sessionPrompt:')),
        `host.sessionPrompt must own the auto turn, got ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.includes('agents.askQuestion'),
        'the direct runner path must not run for auto',
      );
      assert.ok(entries.some((e) => e.message === '[sessions] auto forced host'));
    },
  },
  {
    name: 'stored auto (no body.agentId) → host via history fallback',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, storedAgent: 'auto' });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'напиши Hello World на NodeJS' }, 'cid-stored');
      assert.ok(calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!calls.includes('agents.askQuestion'));
      assert.ok(entries.some((e) => e.message === '[sessions] auto forced host'));
    },
  },
  {
    name: 'ask → direct unchanged (no host prompt, no forced-host log)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, storedAgent: 'ask' });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'объясни что такое Hello World', agentId: 'ask' }, 'cid-ask');
      assert.ok(calls.includes('agents.askQuestion'), `direct must answer ask, got ${JSON.stringify(calls)}`);
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!entries.some((e) => e.message === '[sessions] auto forced host'));
    },
  },
  {
    name: 'unknown agent → honest 404 before any transport',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls });
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
      const svc = wire({ entries, calls, withPaths: true });
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
    name: 'explicit auto wins over stored ask → host',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, storedAgent: 'ask' });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'сделай задачу', agentId: 'auto' }, 'cid-exp-auto');
      assert.ok(calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!calls.includes('agents.askQuestion'));
      assert.ok(entries.some((e) => e.message === '[sessions] auto forced host'));
    },
  },
  {
    name: 'explicit ask wins over stored auto → direct',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, storedAgent: 'auto' });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'объясни', agentId: 'ask' }, 'cid-exp-ask');
      assert.ok(calls.includes('agents.askQuestion'));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!entries.some((e) => e.message === '[sessions] auto forced host'));
    },
  },
  {
    name: 'no agent anywhere defaults to ask → direct (never host)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, storedAgent: undefined });
      await svc.sendMessage(UID, SID, { projectId: PID, text: 'привет' }, 'cid-default');
      assert.ok(calls.includes('agents.askQuestion'));
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
    },
  },
  {
    name: 'auto file command stays jailed (no host prompt)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, withPaths: true });
      const res = await svc.sendMessage(
        UID,
        SID,
        { projectId: PID, text: 'создай файл hello.js с текстом console.log("hi")', agentId: 'auto' },
        'cid-auto-file',
      );
      assert.equal(res.type, 'user');
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(calls.includes('history.appendMessage'));
    },
  },
  {
    name: 'auto traversal → 403 before any host prompt',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, withPaths: true });
      await assert.rejects(
        svc.sendMessage(
          UID,
          SID,
          { projectId: PID, text: 'создай файл ../escape.txt с текстом hi', agentId: 'auto' },
          'cid-auto-403',
        ),
        (err: unknown) => err instanceof ForbiddenException,
      );
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(!calls.includes('history.appendMessage'));
    },
  },
  {
    name: 'auto unbound session → honest 404, no host prompt',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, hostSessionId: null });
      await assert.rejects(
        svc.sendMessage(UID, SID, { projectId: PID, text: 'сделай', agentId: 'auto' }, 'cid-unbound'),
        (err: unknown) => {
          if (!(err instanceof NotFoundException)) return false;
          const res = err.getResponse() as { code?: string };
          return typeof res === 'object' && res !== null && res.code === 'opencode_session_unbound';
        },
      );
      assert.ok(!calls.some((c) => c.startsWith('host.sessionPrompt:')));
    },
  },
  {
    name: 'host failure propagates (no swallow, no fake answer)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, promptError: new Error('host-down') });
      await assert.rejects(
        svc.sendMessage(UID, SID, { projectId: PID, text: 'сделай', agentId: 'auto' }, 'cid-host-fail'),
        (err: unknown) => err instanceof Error && (err as Error).message === 'host-down',
      );
      assert.ok(!calls.includes('history.appendMessage'));
    },
  },
  {
    name: 'invalid agentId type → honest 404 before any transport',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls });
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
    name: 'huge auto text still forced host (no truncation/crash)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls });
      const big = `сделай ${'x'.repeat(100_000)}`;
      await svc.sendMessage(UID, SID, { projectId: PID, text: big, agentId: 'auto' }, 'cid-huge');
      assert.ok(calls.some((c) => c.startsWith('host.sessionPrompt:')));
      assert.ok(entries.some((e) => e.message === '[sessions] auto forced host'));
    },
  },
  {
    name: 'repeat auto prompt is idempotent-safe (two turns, both host)',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls });
      const body = { projectId: PID, text: 'напиши Hello World на NodeJS', agentId: 'auto' as const };
      await svc.sendMessage(UID, SID, body, 'cid-repeat-1');
      await svc.sendMessage(UID, SID, body, 'cid-repeat-2');
      const prompts = calls.filter((c) => c.startsWith('host.sessionPrompt:'));
      assert.equal(prompts.length, 2);
      assert.ok(!calls.includes('agents.askQuestion'));
    },
  },
  {
    name: 'interrupt idle unbound → honest 404',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, hostSessionId: null });
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
      const svc = wire({ entries, calls, interruptResult: { interrupted: false } });
      (svc as unknown as { busyDirect: Set<string> }).busyDirect.add(SID);
      const res = await svc.interrupt(UID, SID, { projectId: PID }, 'cid-int-or');
      assert.equal(res.interrupted, true);
      assert.ok(calls.some((c) => c.startsWith('host.sessionInterrupt:')));
    },
  },
  {
    name: 'interrupt idle bound delegates to host answer',
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<string> = [];
      const svc = wire({ entries, calls, interruptResult: { interrupted: false } });
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
