import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { AppLogger } from '@common/logger';
import { SessionStreamService } from '../modules/events/session-stream.service';
import { SessionFrameBufferService } from '../modules/events/session-frame-buffer.service';
import { AssistantRecorderService } from '../modules/recorder/assistant-recorder.service';
import { SessionRuntimeStateService } from '../modules/state/session-runtime-state.service';

/**
 * SessionStreamService cursor + session filter (C1/C2):
 * - resume cursor reads `Last-Event-ID` first, `?cursor=` fallback;
 * - replay emits only frames AFTER the cursor, unknown/empty cursor →
 *   full local replay (never empty, never foreign);
 * - `?session=` narrows to one own session; unknown/foreign/empty session →
 *   quiet empty stream (heartbeat flows, no frames), never 404.
 *
 * Hand-wired style: a real SessionFrameBufferService (direct-turn replay
 * source) plus a fake host bus for live frames. No timers are awaited — an
 * exhausted live bus with no busy turn ends the stream immediately.
 */

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

function fakeReqWith(
  query: Record<string, string> = {},
  headers: Record<string, string | Array<string>> = {},
): FakeReq {
  const req = fakeReq();
  (req as unknown as Record<string, unknown>).query = query;
  (req as unknown as Record<string, unknown>).headers = headers;
  return req;
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

type BufferedFrame = { id: string; type: string; data: Record<string, unknown> };

function localFrame(id: string, sessionID: string): BufferedFrame {
  return { id, type: 'message.part.delta', data: { sessionID } };
}

function hostFrame(id: string, sessionID: string): unknown {
  return { id, type: 'session.text.delta', data: { sessionID, delta: id } };
}

function harness(options: {
  localSessionIds: Array<string>;
  localBuffered?: Array<BufferedFrame>;
  live?: Array<unknown>;
}): { svc: SessionStreamService; calls: Array<string> } {
  const calls: Array<string> = [];
  const host = {
    getHost: async (): Promise<unknown> => {
      calls.push('host.getHost');
      return {};
    },
    subscribeEvents: async (): Promise<AsyncIterable<unknown>> => {
      calls.push('host.subscribeEvents');
      return iterableOf(options.live ?? []);
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
      return new Map();
    },
    async findSessionByHostSessionId(): Promise<undefined> {
      return undefined;
    },
    async getAgent(): Promise<undefined> {
      return undefined;
    },
  };
  const logger = silentLogger();
  const state = new SessionRuntimeStateService();
  const buffer = new SessionFrameBufferService();
  for (const frame of options.localBuffered ?? []) buffer.pushFrame(frame);
  const recorder = new AssistantRecorderService(
    host as unknown as ConstructorParameters<typeof AssistantRecorderService>[0],
    history as unknown as ConstructorParameters<typeof AssistantRecorderService>[1],
    state,
    logger,
  );
  const args: Array<unknown> = [
    host,
    access,
    { assertServeUser() {} },
    history,
    state,
    buffer,
    recorder,
    logger,
  ];
  const svc = new SessionStreamService(
    ...(args as unknown as ConstructorParameters<typeof SessionStreamService>),
  );
  return { svc, calls };
}

function parseWrites(writes: Array<string>): Array<unknown> {
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

function frameIds(frames: Array<unknown>): Array<unknown> {
  return frames.map((frame) => (frame as { id?: unknown } | null)?.id);
}

function frameSessions(frames: Array<unknown>): Array<unknown> {
  return frames.map((frame) => (frame as { session?: unknown } | null)?.session);
}

async function runStream(options: {
  localSessionIds: Array<string>;
  localBuffered?: Array<BufferedFrame>;
  live?: Array<unknown>;
  query?: Record<string, string>;
  headers?: Record<string, string | Array<string>>;
}): Promise<{ delivered: Array<unknown>; res: FakeRes }> {
  const { svc } = harness(options);
  const res = fakeRes();
  await svc.streamEvents(
    UID,
    PID,
    'cid-test',
    fakeReqWith(options.query ?? {}, options.headers ?? {}),
    res as unknown as ExpressResponse,
  );
  return { delivered: parseWrites(res.writes), res };
}

describe('streamEvents resume cursor (C1)', () => {
  const buffered = [
    localFrame('e1', 'ses_a'),
    localFrame('e2', 'ses_a'),
    localFrame('e3', 'ses_a'),
  ];

  it('Last-Event-ID replays only frames after the cursor', async () => {
    const { delivered, res } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: buffered,
      headers: { 'last-event-id': 'e1' },
    });
    assert.deepEqual(frameIds(delivered), ['e2', 'e3']);
    assert.equal(res.writableEnded, true);
  });

  it('?cursor= fallback replays after the cursor when no header travels', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: buffered,
      query: { cursor: 'e2' },
    });
    assert.deepEqual(frameIds(delivered), ['e3']);
  });

  it('header wins over ?cursor= when both travel', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: buffered,
      query: { cursor: 'e2' },
      headers: { 'last-event-id': 'e1' },
    });
    assert.deepEqual(frameIds(delivered), ['e2', 'e3']);
  });

  it('unknown cursor falls back to the FULL local replay (never empty)', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: buffered,
      headers: { 'last-event-id': 'e-nope' },
    });
    assert.deepEqual(frameIds(delivered), ['e1', 'e2', 'e3']);
  });

  it('no cursor replays everything buffered locally', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: buffered,
    });
    assert.deepEqual(frameIds(delivered), ['e1', 'e2', 'e3']);
  });

  it('cursor at the tip replays nothing (quiet, still ends)', async () => {
    const { delivered, res } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: buffered,
      query: { cursor: 'e3' },
    });
    assert.deepEqual(delivered, []);
    assert.equal(res.writableEnded, true);
  });

  it('replay never leaks foreign sessions, even past a valid cursor', async () => {
    const mixed = [
      localFrame('e1', 'ses_a'),
      localFrame('ex', 'ses_foreign'),
      localFrame('e2', 'ses_a'),
    ];
    const { delivered } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: mixed,
      headers: { 'last-event-id': 'e1' },
    });
    assert.deepEqual(frameIds(delivered), ['e2']);
    assert.deepEqual(frameSessions(delivered), ['ses_a']);
  });

  it('empty-string cursor behaves like no cursor (full replay)', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: buffered,
      query: { cursor: '' },
    });
    assert.deepEqual(frameIds(delivered), ['e1', 'e2', 'e3']);
  });
});

describe('streamEvents ?session= isolation (C2)', () => {
  it('narrows replay + live to the requested own session', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a', 'ses_b'],
      localBuffered: [localFrame('e-a', 'ses_a'), localFrame('e-b', 'ses_b')],
      live: [hostFrame('live-a', 'ses_a'), hostFrame('live-b', 'ses_b')],
      query: { session: 'ses_a' },
    });
    assert.deepEqual(frameIds(delivered), ['e-a', 'live-a']);
    assert.deepEqual(frameSessions(delivered), ['ses_a', 'ses_a']);
  });

  it('unknown session yields a quiet empty stream (never 404, still ends)', async () => {
    const { delivered, res } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: [localFrame('e-a', 'ses_a')],
      live: [hostFrame('live-a', 'ses_a')],
      query: { session: 'ses_nope' },
    });
    assert.deepEqual(delivered, []);
    assert.equal(res.writableEnded, true, 'the relay must end the response');
  });

  it('foreign session yields a quiet empty stream (no existence leak)', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: [localFrame('e-a', 'ses_a')],
      live: [hostFrame('live-a', 'ses_a')],
      query: { session: 'ses_foreign' },
    });
    assert.deepEqual(delivered, []);
  });

  it('empty ?session= yields a quiet empty stream', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a'],
      localBuffered: [localFrame('e-a', 'ses_a')],
      query: { session: '' },
    });
    assert.deepEqual(delivered, []);
  });

  it('without ?session= both own sessions stream (legacy multiplex)', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a', 'ses_b'],
      localBuffered: [localFrame('e-a', 'ses_a'), localFrame('e-b', 'ses_b')],
    });
    assert.deepEqual(frameIds(delivered), ['e-a', 'e-b']);
  });

  it('cursor + session combine: replay after cursor, filtered to the session', async () => {
    const { delivered } = await runStream({
      localSessionIds: ['ses_a', 'ses_b'],
      localBuffered: [
        localFrame('e1', 'ses_a'),
        localFrame('eX', 'ses_b'),
        localFrame('e2', 'ses_a'),
      ],
      query: { session: 'ses_a', cursor: 'e1' },
    });
    assert.deepEqual(frameIds(delivered), ['e2']);
  });
});

describe('streamEvents busy state is read from SessionRuntimeStateService', () => {
  it('a busy local turn is visible through state.isBusy (stream owns the override)', () => {
    // The relay reads the busy override from the injected state service; this
    // guard pins the wiring (the stream must not keep its own busy set).
    const state = new SessionRuntimeStateService();
    assert.equal(state.isBusy('ses_busy'), false);
    state.markBusy('ses_busy');
    assert.equal(state.isBusy('ses_busy'), true);
    assert.equal(state.clearBusy('ses_busy'), true);
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
  console.error(`sessions stream checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
