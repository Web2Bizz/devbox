import assert from 'node:assert/strict';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AppLogger } from '../../../../../../common/logger';
import type { RevertInfo, SessionForkResponse, SnapshotDiff } from '../sessions.dto';
import { SessionHarnessService } from '../session-harness.service';
import { SessionsService } from '../sessions.service';

const UID = '123e4567-e89b-12d3-a456-426614174001';
const PID = '123e4567-e89b-12d3-a456-426614174003';
const DIR = `/tmp/repos/orgs/${UID}/projects/${PID}/content`;
const SRC = '123e4567-e89b-12d3-a456-426614174010';

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

type Message = { id: string; type: string; createdAt: string; text: string | null };

const MESSAGES: Array<Message> = [
  { id: 'm1', type: 'user', createdAt: '2026-01-01T00:00:00.000Z', text: 'one' },
  { id: 'm2', type: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', text: 'two' },
  { id: 'm3', type: 'user', createdAt: '2026-01-01T00:00:02.000Z', text: 'three' },
];

type Appended = {
  id: string;
  sessionId: string;
  projectId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt?: string;
};

function harness(messages: Array<Message>): {
  svc: SessionsService;
  appended: Array<Appended>;
} {
  const appended: Array<Appended> = [];
  const host = {
    async sessionCreate(input: { title?: string | null }): Promise<unknown> {
      return { id: 'ses_fork_host', title: input.title ?? null };
    },
  };
  const access = {
    async resolveProjectDirectory(projectId: string, userId: string): Promise<unknown> {
      return { projectId, directory: DIR, userId };
    },
  };
  const auth = { assertServeUser() {} };
  const history = {
    async listMessages(): Promise<Array<Message>> {
      return messages;
    },
    async getAgent(): Promise<undefined> {
      return undefined;
    },
    async listLocalSessions(): Promise<Array<Record<string, unknown>>> {
      return [
        {
          id: SRC,
          title: 'Source session',
          createdAt: '2026-01-01T00:00:00.000Z',
          directory: DIR,
          projectId: PID,
          model: null,
          agentId: 'ask',
          status: { type: 'idle' },
        },
      ];
    },
    async saveLocalSession(): Promise<void> {},
    async setHostSessionId(): Promise<void> {},
    async setAgent(): Promise<void> {},
    async appendMessage(row: Appended): Promise<void> {
      appended.push(row);
    },
    async discardSession(): Promise<void> {},
  };
  const agents = {
    list: (): Array<{ id: string; name: string; description: string }> => [
      { id: 'ask', name: 'Ask', description: '' },
    ],
    async askQuestion(): Promise<string> {
      return '';
    },
  };
  const harnessSvc = new SessionHarnessService(
    ...([
      host,
      access,
      auth,
      history,
      undefined,
      silentLogger(),
      agents,
    ] as unknown as ConstructorParameters<typeof SessionHarnessService>),
  );
  return { svc: new SessionsService(harnessSvc), appended };
}

describe('SessionHarness.fork', () => {
  it('copies the whole thread through the newest message by default', async () => {
    const { svc, appended } = harness(MESSAGES);
    const result: SessionForkResponse = await svc.fork(UID, SRC, { projectId: PID }, 'cid');
    assert.notEqual(result.session.id, SRC);
    assert.deepEqual(result.boundary, { type: 'through', messageID: 'm3' });
    assert.equal(appended.length, 3);
    assert.ok(appended.every((row) => row.sessionId === result.session.id));
    assert.deepEqual(
      appended.map((row) => row.text),
      ['one', 'two', 'three'],
    );
  });

  it('copies only messages strictly before the boundary', async () => {
    const { svc, appended } = harness(MESSAGES);
    const result = await svc.fork(UID, SRC, { projectId: PID, before: 'm2' }, 'cid');
    assert.deepEqual(result.boundary, { type: 'before', messageID: 'm2' });
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.text, 'one');
  });

  it('answers MessageNotFound for an unknown boundary', async () => {
    const { svc } = harness(MESSAGES);
    await assert.rejects(
      svc.fork(UID, SRC, { projectId: PID, before: 'missing' }, 'cid'),
      (err: unknown) => err instanceof NotFoundException,
    );
  });

  it('answers ForkEmpty for an empty thread', async () => {
    const { svc } = harness([]);
    await assert.rejects(
      svc.fork(UID, SRC, { projectId: PID }, 'cid'),
      (err: unknown) => err instanceof ConflictException,
    );
  });
});

/**
 * Type-only guards: the facade must keep answering the frozen wire shapes.
 * Never executed — they only make a signature drift a compile error.
 */
export type ForkWireShape = SessionForkResponse;
export type RevertWireShape = RevertInfo;
export type DiffWireShape = Array<SnapshotDiff>;

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
  console.error(`session fork checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
