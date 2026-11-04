import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { AppLogger } from '../../../../../../common/logger';
import { SessionsService } from '../sessions.service';
import { SessionHarnessService } from '../session-harness.service';

const UID = '123e4567-e89b-12d3-a456-426614174001';
const PID = '123e4567-e89b-12d3-a456-426614174003';
const JAIL = '/tmp/repos';
const DIR = `${JAIL}/users/${UID}/projects/${PID}/content`;

type Case = { name: string; run: () => Promise<void> | void };

const cases: Array<Case> = [];
let currentSuite = '';

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = '';
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
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

type FakeReq = ExpressRequest & { destroyed: boolean };

function fakeReq(): FakeReq {
  const emitter = new EventEmitter() as EventEmitter & { destroyed: boolean };
  emitter.destroyed = false;
  return emitter as unknown as FakeReq;
}

type FakeRes = {
  writes: Array<string>;
  headers: Record<string, string>;
  writableEnded: boolean;
  destroyed: boolean;
  setHeader: (name: string, value: string) => void;
  flushHeaders: () => void;
  write: (chunk: unknown) => boolean;
  end: () => void;
};

function fakeRes(): FakeRes {
  const writes: Array<string> = [];
  const headers: Record<string, string> = {};
  const res: FakeRes = {
    writes,
    headers,
    writableEnded: false,
    destroyed: false,
    setHeader: (name, value) => {
      headers[name] = value;
    },
    flushHeaders: () => {},
    write: (chunk) => {
      writes.push(String(chunk));
      return true;
    },
    end: () => {
      res.writableEnded = true;
    },
  };
  return res;
}

function streamOf(frames: Array<unknown>): {
  stream: AsyncIterable<unknown> & { return?: (v?: unknown) => Promise<unknown> };
} {
  return {
    stream: {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        for (const frame of frames) yield frame;
      },
      async return(): Promise<unknown> {
        return { done: true, value: undefined };
      },
    },
  };
}

type Frame = { id: string; type: string; data: Record<string, unknown> };

function sessionFrame(id: string, sessionID: string): Frame {
  return { id, type: 'message.part.updated', data: { sessionID, part: { text: id } } };
}

function unscopedFrame(id: string): Frame {
  return { id, type: 'server.connected', data: { version: '2.2.0' } };
}

function sessionCreatedFrame(id: string, sessionID: string, directory: string): Frame {
  return {
    id,
    type: 'session.created',
    data: { id: sessionID, sessionID, location: { directory } },
  };
}

function sessionDeletedFrame(id: string, sessionID: string): Frame {
  return { id, type: 'session.deleted', data: { id: sessionID, sessionID } };
}

function upstreamRow(id: string): Record<string, unknown> {
  return {
    id,
    projectID: 'upstream-project-hash',
    title: id,
    time: { created: 1700000000000, updated: 1700000000000 },
    location: { directory: DIR },
  };
}

function clientMock(sessionIds: Array<string>, frames: Array<unknown>): {
  client: Record<string, unknown>;
  calls: Array<string>;
} {
  const calls: Array<string> = [];
  const client = {
    v2: {
      session: {
        list: async (): Promise<unknown> => {
          calls.push('session.list');
          return { data: { data: sessionIds.map(upstreamRow) } };
        },
        active: async (): Promise<unknown> => {
          calls.push('session.active');
          return { data: { data: {} } };
        },
      },
      event: {
        subscribe: async (): Promise<unknown> => {
          calls.push('event.subscribe');
          return streamOf(frames);
        },
      },
    },
  };
  return { client, calls };
}

type Harness = {
  svc: SessionsService;
  calls: Array<string>;
};

function harness(sessionIds: Array<string>, frames: Array<unknown>): Harness {
  const { client, calls } = clientMock(sessionIds, frames);
  const sdk = {
    create: async (userId: string): Promise<unknown> => {
      calls.push(`sdk.create:${userId}`);
      return client;
    },
  };
  const opencode = {
    checkConnectivity: async (): Promise<'up' | 'down'> => 'up',
  };
  const access = {
    resolveProjectDirectory: async (
      projectId: string,
      userId: string,
    ): Promise<unknown> => {
      calls.push(`access:${projectId}:${userId}`);
      return { projectId, directory: DIR };
    },
  };
  // History store is empty here: these checks exercise the live-stand path.
  const history = {
    async listLocalSessions(): Promise<Array<unknown>> {
      return [];
    },
    async listSessionIdsWithMessages(): Promise<Array<string>> {
      return [];
    },
    async listAgents(): Promise<Map<string, string>> {
      return new Map();
    },
  } as unknown as ConstructorParameters<typeof SessionHarnessService>[4];
  const args: Array<unknown> = [
    sdk,
    opencode,
    access,
    {},
    history,
    undefined,
    silentLogger(),
  ];
  const harnessSvc = new SessionHarnessService(
    ...(args as unknown as ConstructorParameters<typeof SessionHarnessService>),
  );
  const svc = new SessionsService(harnessSvc);
  return { svc, calls };
}

function parseWrites(writes: Array<string>): Array<unknown> {
  return writes
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length).replace(/\n\n$/, '')));
}

async function runStream(
  sessionIds: Array<string>,
  frames: Array<unknown>,
): Promise<{ delivered: Array<unknown>; res: FakeRes; calls: Array<string> }> {
  const { svc, calls } = harness(sessionIds, frames);
  const res = fakeRes();
  await svc.streamEvents(UID, PID, 'cid-test', fakeReq(), res as unknown as ExpressResponse);
  return { delivered: parseWrites(res.writes), res, calls };
}

function frameSessions(frames: Array<unknown>): Array<unknown> {
  return frames.map((frame) => (frame as { session?: unknown } | null)?.session);
}

function frameIds(frames: Array<unknown>): Array<unknown> {
  return frames.map((frame) => (frame as { id?: unknown } | null)?.id);
}

describe('SessionsService.streamEvents project scoping', () => {
  it('delivers frames whose session belongs to the requested project', async () => {
    const own = sessionFrame('e-own', 'ses_own');
    const { delivered, res } = await runStream(['ses_own'], [own]);
    assert.deepEqual(frameIds(delivered), ['e-own']);
    assert.deepEqual(frameSessions(delivered), ['ses_own']);
    assert.equal(res.writableEnded, true, 'the relay must end the response');
  });

  it('drops frames from sessions of another project', async () => {
    const own = sessionFrame('e-own', 'ses_own');
    const foreign = sessionFrame('e-foreign', 'ses_foreign');
    const { delivered } = await runStream(['ses_own'], [own, foreign]);
    assert.deepEqual(
      frameIds(delivered),
      ['e-own'],
      `a foreign session frame leaked into the stream: ${JSON.stringify(frameSessions(delivered))}`,
    );
  });

  it('drops frames without a session id (cannot be attributed to the project)', async () => {
    const unscoped = unscopedFrame('e-unscoped');
    const { delivered } = await runStream(['ses_own'], [unscoped]);
    assert.deepEqual(
      delivered,
      [],
      `an unscoped frame leaked into the stream: ${JSON.stringify(delivered)}`,
    );
  });

  it('delivers nothing when the project has no sessions', async () => {
    const frames = [sessionFrame('e-own', 'ses_own'), sessionFrame('e-foreign', 'ses_foreign')];
    const { delivered } = await runStream([], frames);
    assert.deepEqual(
      delivered,
      [],
      `frames leaked into an empty-project stream: ${JSON.stringify(frameSessions(delivered))}`,
    );
  });

  it('delivers frames of every session owned by the project', async () => {
    const first = sessionFrame('e-first', 'ses_a');
    const second = sessionFrame('e-second', 'ses_b');
    const foreign = sessionFrame('e-foreign', 'ses_c');
    const { delivered } = await runStream(['ses_a', 'ses_b'], [first, second, foreign]);
    assert.deepEqual(frameIds(delivered), ['e-first', 'e-second']);
    assert.deepEqual(frameSessions(delivered), ['ses_a', 'ses_b']);
  });

  it('starts delivering a project session created after the stream opened', async () => {
    const created = sessionCreatedFrame('e-created', 'ses_new', DIR);
    const followUp = sessionFrame('e-new', 'ses_new');
    const foreignCreated = sessionCreatedFrame('e-foreign-created', 'ses_foreign', '/tmp/other');
    const foreign = sessionFrame('e-foreign', 'ses_foreign');
    const { delivered, calls } = await runStream([], [
      created,
      followUp,
      foreignCreated,
      foreign,
    ]);
    assert.deepEqual(frameIds(delivered), ['e-created', 'e-new']);
    assert.equal(
      calls.filter((call) => call === 'session.list').length,
      1,
      'the session snapshot must not be re-listed per frame',
    );
    assert.equal(
      calls.filter((call) => call.startsWith('access:')).length,
      1,
      'the project gate must be resolved once per stream',
    );
  });

  it('removes a deleted session from the live set', async () => {
    const own = sessionFrame('e-own', 'ses_own');
    const deleted = sessionDeletedFrame('e-deleted', 'ses_own');
    const after = sessionFrame('e-after', 'ses_own');
    const { delivered } = await runStream(['ses_own'], [own, deleted, after]);
    assert.deepEqual(
      frameIds(delivered),
      ['e-own'],
      `a deleted session kept leaking frames: ${JSON.stringify(frameSessions(delivered))}`,
    );
  });

  it('does not grant access from a foreign session.created frame', async () => {
    const foreignCreated = sessionCreatedFrame('e-fc', 'ses_foreign', '/tmp/other');
    const foreign = sessionFrame('e-foreign', 'ses_foreign');
    const { delivered } = await runStream([], [foreignCreated, foreign]);
    assert.deepEqual(
      delivered,
      [],
      `foreign session.created granted access: ${JSON.stringify(frameSessions(delivered))}`,
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
  console.error(`sessions service checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
