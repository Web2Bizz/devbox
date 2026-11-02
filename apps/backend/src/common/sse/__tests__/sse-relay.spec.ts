import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { AppLogger } from '../../logger';
import { relaySse, type SseRelayParams, type SseSubscription } from '../sse-relay';

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

function asRequest(fake: FakeReq): ExpressRequest {
  return fake;
}

function asResponse(fake: FakeRes): ExpressResponse {
  return fake as unknown as ExpressResponse;
}

function streamOf(frames: Array<unknown>, onReturn?: () => void): SseSubscription {
  return {
    stream: {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        for (const frame of frames) yield frame;
      },
      async return(): Promise<unknown> {
        onReturn?.();
        return { done: true, value: undefined };
      },
    },
  };
}

function baseParams(over: {
  req: FakeReq;
  res: FakeRes;
  subscribe: (signal: AbortSignal) => Promise<SseSubscription>;
  filterFrame?: (frame: unknown) => boolean;
  mapFrame?: (value: unknown) => unknown;
  logger?: AppLogger;
}): SseRelayParams {
  return {
    operation: 'GET /test-events',
    cid: 'cid-test',
    req: asRequest(over.req),
    res: asResponse(over.res),
    subscribe: over.subscribe,
    logger: over.logger ?? silentLogger(),
    prefix: '[test]',
    probe: async () => 'up',
    unreachableError: () => new Error('unreachable'),
    subscribeFailedError: (error: unknown) => new Error(String(error)),
    ...(over.mapFrame ? { mapFrame: over.mapFrame } : {}),
    ...(over.filterFrame ? { filterFrame: over.filterFrame } : {}),
  } as unknown as SseRelayParams;
}

function parseWrites(writes: Array<string>): Array<unknown> {
  return writes
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length).replace(/\n\n$/, '')));
}

function captureLogger(sink: Array<string>): AppLogger {
  return {
    debug(message: unknown) {
      sink.push(String(message));
    },
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as AppLogger;
}

const FRAMES = [
  { id: 'e1', type: 'message.part.updated', data: { sessionID: 'ses_own' } },
  { id: 'e2', type: 'message.part.updated', data: { sessionID: 'ses_foreign' } },
  { id: 'e3', type: 'session.created', data: { sessionID: 'ses_other' } },
];

describe('relaySse frame delivery', () => {
  it('writes every frame when no filterFrame is supplied', async () => {
    const req = fakeReq();
    const res = fakeRes();
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf(FRAMES),
      }),
    );
    assert.deepEqual(parseWrites(res.writes), FRAMES);
    assert.equal(res.writableEnded, true, 'the relay must end the response');
  });

  it('skips frames rejected by filterFrame', async () => {
    const req = fakeReq();
    const res = fakeRes();
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf(FRAMES),
        filterFrame: (frame) =>
          (frame as { data?: { sessionID?: unknown } })?.data?.sessionID === 'ses_own',
        mapFrame: (value) => value,
      }),
    );
    const delivered = parseWrites(res.writes);
    assert.deepEqual(
      delivered,
      [FRAMES[0]],
      `filtered frames leaked into the stream: ${JSON.stringify(delivered)}`,
    );
    assert.equal(res.writableEnded, true, 'the relay must end the response');
  });

  it('reports the number of filtered frames at debug without frame content', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const logs: Array<string> = [];
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf(FRAMES),
        logger: captureLogger(logs),
        filterFrame: (frame) =>
          (frame as { data?: { sessionID?: unknown } })?.data?.sessionID === 'ses_own',
      }),
    );
    assert.deepEqual(parseWrites(res.writes), [FRAMES[0]]);
    const dropLog = logs.find((line) => line.includes('dropped') && line.includes('2'));
    assert.ok(
      dropLog,
      `expected a debug count of the 2 dropped frames, got: ${JSON.stringify(logs)}`,
    );
    const joined = logs.join(' ');
    assert.ok(!joined.includes('ses_foreign'), 'dropped frame content leaked into the log');
    assert.ok(!joined.includes('ses_other'), 'dropped frame content leaked into the log');
    assert.equal(res.writableEnded, true, 'the relay must end the response');
  });

  it('writes nothing when filterFrame rejects every frame', async () => {
    const req = fakeReq();
    const res = fakeRes();
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf(FRAMES),
        filterFrame: () => false,
      }),
    );
    assert.deepEqual(res.writes, [], 'a rejecting predicate must suppress every frame');
    assert.equal(res.writableEnded, true, 'the relay must still end the response');
  });

  it('delivers nothing for an empty upstream stream with a predicate', async () => {
    const req = fakeReq();
    const res = fakeRes();
    let filtered = 0;
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf([]),
        filterFrame: () => {
          filtered += 1;
          return true;
        },
      }),
    );
    assert.deepEqual(res.writes, []);
    assert.equal(filtered, 0, 'the predicate must only see actual frames');
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
  console.error(`sse relay checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
