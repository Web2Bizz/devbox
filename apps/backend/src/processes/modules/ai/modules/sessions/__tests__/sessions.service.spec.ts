import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { AppLogger } from '../../../../../../common/logger';
import { SessionsService } from '../sessions.service';
import { SessionHarnessService } from '../session-harness.service';

const UID = '123e4567-e89b-12d3-a456-426614174001';
const PID = '123e4567-e89b-12d3-a456-426614174003';
const JAIL = '/tmp/repos';
const DIR = `${JAIL}/orgs/${UID}/projects/${PID}/content`;

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

function iterableOf(frames: Array<unknown>): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const frame of frames) yield frame;
    },
  };
}

type Frame = { id: string; type: string; data: Record<string, unknown> };

function sessionFrame(id: string, sessionID: string): Frame {
  return { id, type: 'session.text.delta', data: { sessionID, delta: id } };
}

function unscopedFrame(id: string): Frame {
  return { id, type: 'server.connected', data: { version: '2.2.5' } };
}

type Harness = { svc: SessionsService; calls: Array<string> };

function harness(options: {
  localSessionIds: Array<string>;
  hostBindings?: Map<string, string>;
  frames: Array<unknown>;
}): Harness {
  const calls: Array<string> = [];
  const host = {
    getHost: async (): Promise<unknown> => {
      calls.push('host.getHost');
      return {};
    },
    isUp: (): boolean => true,
    subscribeEvents: async (): Promise<AsyncIterable<unknown>> => {
      calls.push('host.subscribeEvents');
      return iterableOf(options.frames);
    },
  };
  const access = {
    resolveProjectDirectory: async (projectId: string, userId: string): Promise<unknown> => {
      calls.push(`access:${projectId}:${userId}`);
      return { projectId, directory: DIR };
    },
  };
  const history = {
    async listLocalSessions(): Promise<Array<unknown>> {
      return options.localSessionIds.map((id) => ({ id }));
    },
    async listSessionIdsWithMessages(): Promise<Array<string>> {
      return [];
    },
    async listHostBindings(): Promise<Map<string, string>> {
      return options.hostBindings ?? new Map();
    },
    async findSessionByHostSessionId(): Promise<undefined> {
      return undefined;
    },
    async getAgent(): Promise<undefined> {
      return undefined;
    },
  };
  const args: Array<unknown> = [
    host,
    access,
    { assertServeUser() {} },
    history,
    undefined,
    silentLogger(),
  ];
  const harnessSvc = new SessionHarnessService(
    ...(args as unknown as ConstructorParameters<typeof SessionHarnessService>),
  );
  return { svc: new SessionsService(harnessSvc), calls };
}

function parseWrites(writes: Array<string>): Array<unknown> {
  // C0 wire format: every data frame is written as ONE chunk
  // `id: <id>\nevent: message\ndata: {...}\n\n` (id-less frames are bare
  // `data: {...}\n\n`); heartbeats (`: ping`) are transport-only. Extract
  // the data: lines per chunk instead of matching the chunk start.
  const out: Array<unknown> = [];
  for (const chunk of writes) {
    if (chunk.startsWith(': ping')) continue;
    const dataLines: Array<string> = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (dataLines.length === 0) continue;
    out.push(JSON.parse(dataLines.join('\n')));
  }
  return out;
}

async function runStream(options: {
  localSessionIds: Array<string>;
  hostBindings?: Map<string, string>;
  frames: Array<unknown>;
}): Promise<{ delivered: Array<unknown>; res: FakeRes; calls: Array<string> }> {
  const { svc, calls } = harness(options);
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

describe('SessionsService.streamEvents project scoping (embedded host)', () => {
  it('delivers frames whose session belongs to the requested project', async () => {
    const own = sessionFrame('e-own', 'ses_own');
    const { delivered, res } = await runStream({
      localSessionIds: ['ses_own'],
      frames: [own],
    });
    assert.deepEqual(frameIds(delivered), ['e-own']);
    assert.deepEqual(frameSessions(delivered), ['ses_own']);
    assert.equal(res.writableEnded, true, 'the relay must end the response');
  });

  it('drops frames from sessions of another project', async () => {
    const own = sessionFrame('e-own', 'ses_own');
    const foreign = sessionFrame('e-foreign', 'ses_foreign');
    const { delivered } = await runStream({
      localSessionIds: ['ses_own'],
      frames: [own, foreign],
    });
    assert.deepEqual(
      frameIds(delivered),
      ['e-own'],
      `a foreign session frame leaked into the stream: ${JSON.stringify(frameSessions(delivered))}`,
    );
  });

  it('drops frames without a session id (cannot be attributed to the project)', async () => {
    const unscoped = unscopedFrame('e-unscoped');
    const { delivered } = await runStream({
      localSessionIds: ['ses_own'],
      frames: [unscoped],
    });
    assert.deepEqual(
      delivered,
      [],
      `an unscoped frame leaked into the stream: ${JSON.stringify(delivered)}`,
    );
  });

  it('delivers nothing when the project has no sessions', async () => {
    const frames = [sessionFrame('e-own', 'ses_own'), sessionFrame('e-foreign', 'ses_foreign')];
    const { delivered } = await runStream({ localSessionIds: [], frames });
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
    const { delivered } = await runStream({
      localSessionIds: ['ses_a', 'ses_b'],
      frames: [first, second, foreign],
    });
    assert.deepEqual(frameIds(delivered), ['e-first', 'e-second']);
    assert.deepEqual(frameSessions(delivered), ['ses_a', 'ses_b']);
  });

  it('re-keys a host session id to OUR durable uuid', async () => {
    const hostFrame = sessionFrame('e-host', 'ses_e2e_alpha');
    const { delivered } = await runStream({
      localSessionIds: ['123e4567-e89b-12d3-a456-426614174092'],
      hostBindings: new Map([['ses_e2e_alpha', '123e4567-e89b-12d3-a456-426614174092']]),
      frames: [hostFrame],
    });
    assert.deepEqual(frameIds(delivered), ['e-host']);
    assert.deepEqual(frameSessions(delivered), ['123e4567-e89b-12d3-a456-426614174092']);
    const data = (delivered[0] as { data?: Record<string, unknown> }).data ?? {};
    assert.equal(data.sessionID, '123e4567-e89b-12d3-a456-426614174092');
    assert.equal(data.delta, 'e-host', 'the variant payload must pass through intact');
  });

  it('drops an unbound host session (never leaks another project host id)', async () => {
    const foreignHost = sessionFrame('e-foreign-host', 'ses_foreign_host');
    const { delivered } = await runStream({
      localSessionIds: ['ses_own'],
      hostBindings: new Map([['ses_e2e_alpha', 'ses_own']]),
      frames: [foreignHost],
    });
    assert.deepEqual(delivered, []);
  });

  it('resolves the gate once and keeps one recorder + one stream subscription', async () => {
    const { calls } = await runStream({
      localSessionIds: ['ses_own'],
      frames: [sessionFrame('e-own', 'ses_own'), sessionFrame('e-own-2', 'ses_own')],
    });
    assert.equal(
      calls.filter((call) => call.startsWith('access:')).length,
      1,
      'the project gate must be resolved once per stream',
    );
    const hostSubs = calls.filter((call) => call === 'host.subscribeEvents').length;
    // streamEvents lazily starts the single process-level assistant recorder
    // (test harnesses are fresh per case), then subscribes the client stream.
    assert.equal(hostSubs, 2, `expected recorder + stream subscription, got ${hostSubs}`);
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
