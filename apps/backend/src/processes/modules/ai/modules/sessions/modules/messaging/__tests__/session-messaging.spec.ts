import assert from 'node:assert/strict';
import { HttpException, NotFoundException } from '@nestjs/common';
import type { AppLogger } from '@common/logger';
import type { SessionRunnerService } from '@common/zen/session-runner.service';
import type { SessionHistoryRepository } from '../../../session-history.repository';
import type { SendMessageInput, SessionMessage } from '../../../sessions.dto';
import type { DirectTurnService } from '../direct-turn.service';
import type { FileCommandTurnService } from '../file-command.turn';
import type { HostTurnService } from '../host-turn.service';
import type { InProcessTurnService } from '../in-process-turn.service';
import { SessionMessagingService } from '../session-messaging.service';

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

function body(overrides: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    projectId: '00000000-0000-7000-8000-000000000001',
    text: 'hello',
    ...overrides,
  };
}

function receipt(text: string): SessionMessage {
  return {
    id: `id-${text}`,
    type: 'user',
    createdAt: new Date(0).toISOString(),
    text,
  };
}

type HarnessOptions = {
  storedAgent?: string;
  fileResult?: SessionMessage | null;
  runner?: boolean;
  directError?: unknown;
  inProcessError?: unknown;
};

type Calls = {
  file: Array<{ agentId: string }>;
  direct: Array<{ agentId: string; body: SendMessageInput }>;
  host: Array<{ agentId: string; body: SendMessageInput }>;
  inProcess: Array<{ agentId: string; body: SendMessageInput }>;
};

function makeHarness(options: HarnessOptions = {}): {
  messaging: SessionMessagingService;
  calls: Calls;
} {
  const { logger } = recordingLogger();
  const calls: Calls = { file: [], direct: [], host: [], inProcess: [] };
  const history = {
    getAgent: async (_sessionId: string) => options.storedAgent,
  } as unknown as SessionHistoryRepository;
  const fileTurn = {
    tryHandle: async (input: { agentId: string }) => {
      calls.file.push({ agentId: input.agentId });
      return options.fileResult ?? null;
    },
  } as unknown as FileCommandTurnService;
  const directTurn = {
    send: async (input: { agentId: string; body: SendMessageInput }) => {
      calls.direct.push({ agentId: input.agentId, body: input.body });
      if (options.directError !== undefined) throw options.directError;
      return receipt('direct');
    },
  } as unknown as DirectTurnService;
  const hostTurn = {
    send: async (input: { agentId: string; body: SendMessageInput }) => {
      calls.host.push({ agentId: input.agentId, body: input.body });
      return receipt('host');
    },
  } as unknown as HostTurnService;
  const inProcess = {
    send: async (input: { agentId: string; body: SendMessageInput }) => {
      calls.inProcess.push({ agentId: input.agentId, body: input.body });
      if (options.inProcessError !== undefined) throw options.inProcessError;
      return receipt('in-process');
    },
  } as unknown as InProcessTurnService;
  const runner = options.runner ? ({} as SessionRunnerService) : undefined;
  const messaging = new SessionMessagingService(
    history,
    fileTurn,
    directTurn,
    hostTurn,
    inProcess,
    runner,
    logger,
  );
  return { messaging, calls };
}

describe('SessionMessagingService', () => {
  it('file command intercepts the turn: transports are never called', async () => {
    const { messaging, calls } = makeHarness({ fileResult: receipt('file') });
    const result = await messaging.send('u1', 's1', body(), '/repo', undefined, 'cid-1');
    assert.equal(result.id, 'id-file');
    assert.equal(calls.file.length, 1);
    assert.equal(calls.direct.length, 0);
    assert.equal(calls.host.length, 0);
  });

  it("agentId='auto' runs in process (host never prompted)", async () => {
    const { messaging, calls } = makeHarness();
    const result = await messaging.send('u1', 's1', body(), '/repo', 'auto', 'cid-1');
    assert.equal(result.id, 'id-in-process');
    assert.deepEqual(calls.file, [{ agentId: 'auto' }]);
    assert.equal(calls.inProcess.length, 1);
    assert.equal(calls.inProcess[0]?.agentId, 'auto');
    assert.equal(calls.direct.length, 0);
    assert.equal(calls.host.length, 0);
  });

  it('auto without a key (404 opencode_key_missing) is rethrown, host never prompted', async () => {
    const missing = new NotFoundException({
      code: 'opencode_key_missing',
      message: 'No OpenCode API key configured for this user',
    });
    const { messaging, calls } = makeHarness({ inProcessError: missing });
    await assert.rejects(
      messaging.send('u1', 's1', body(), '/repo', 'auto', 'cid-1'),
      (err: unknown) => err instanceof NotFoundException,
    );
    assert.equal(calls.inProcess.length, 1);
    assert.equal(calls.host.length, 0);
    assert.equal(calls.direct.length, 0);
  });

  it('direct runner without a key (404 opencode_key_missing) falls back to the host', async () => {
    const missing = new NotFoundException({
      code: 'opencode_key_missing',
      message: 'No OpenCode API key configured for this user',
    });
    const { messaging, calls } = makeHarness({ runner: true, directError: missing });
    const result = await messaging.send('u1', 's1', body(), '/repo', undefined, 'cid-1');
    assert.equal(result.id, 'id-host');
    assert.equal(calls.direct.length, 1);
    assert.equal(calls.host.length, 1);
  });

  it('a direct 500 is rethrown and the host is never prompted', async () => {
    const { messaging, calls } = makeHarness({
      runner: true,
      directError: new HttpException('boom', 500),
    });
    await assert.rejects(
      messaging.send('u1', 's1', body(), '/repo', undefined, 'cid-1'),
      (err: unknown) => err instanceof HttpException && err.getStatus() === 500,
    );
    assert.equal(calls.direct.length, 1);
    assert.equal(calls.host.length, 0);
  });

  it('without a runner the host turn owns the message', async () => {
    const { messaging, calls } = makeHarness();
    const result = await messaging.send('u1', 's1', body(), '/repo', undefined, 'cid-1');
    assert.equal(result.id, 'id-host');
    assert.equal(calls.direct.length, 0);
    assert.equal(calls.host.length, 1);
  });

  it('explicitAgentId is forwarded to every turn service', async () => {
    const { messaging, calls } = makeHarness({ runner: true });
    await messaging.send('u1', 's1', body(), '/repo', 'ask', 'cid-1');
    assert.equal(calls.file[0]?.agentId, 'ask');
    assert.equal(calls.direct[0]?.agentId, 'ask');
  });

  it("falls back to the stored agent, then 'ask'", async () => {
    const stored = makeHarness({ storedAgent: 'auto' });
    await stored.messaging.send('u1', 's1', body(), '/repo', undefined, 'cid-1');
    assert.equal(stored.calls.inProcess[0]?.agentId, 'auto');
    assert.equal(stored.calls.host.length, 0);

    const fallback = makeHarness();
    await fallback.messaging.send('u1', 's1', body(), '/repo', undefined, 'cid-1');
    assert.equal(fallback.calls.file[0]?.agentId, 'ask');
    assert.equal(fallback.calls.host[0]?.agentId, 'ask');
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
  console.error(`session messaging checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
