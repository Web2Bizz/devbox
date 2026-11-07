import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { AppLogger } from '../../logger';
import { HEARTBEAT_MS, isAbortError, relaySse, type SseRelayParams, type SseSubscription } from '../sse-relay';

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

function chunkIds(writes: Array<string>): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  for (const chunk of writes) {
    if (chunk.startsWith(': ping')) continue;
    let id: string | undefined;
    let hasData = false;
    for (const line of chunk.split('\n')) {
      if (line.startsWith('id:')) id = line.slice('id:'.length).trim();
      if (line.startsWith('data:')) hasData = true;
    }
    if (hasData) out.push(id);
  }
  return out;
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

  it('prefixes every data frame with its id: line (Last-Event-ID redial)', async () => {
    const req = fakeReq();
    const res = fakeRes();
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf(FRAMES),
      }),
    );
    assert.deepEqual(chunkIds(res.writes), ['e1', 'e2', 'e3']);
  });

  it('writes a terminal stream.error frame on mid-stream failure, then ends', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const boom = new Error('runner exploded');
    const failing = {
      stream: {
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
          yield FRAMES[0];
          throw boom;
        },
      },
    } satisfies SseSubscription;
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => failing,
      }),
    );
    const delivered = parseWrites(res.writes) as Array<{ type?: unknown }>;
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1]?.type, 'stream.error');
    assert.equal(res.writableEnded, true, 'the relay must end after stream.error');
  });

  it('stays quiet (no stream.error) on downstream abort', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const aborting = {
      stream: {
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
          yield FRAMES[0];
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      },
    } satisfies SseSubscription;
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => aborting,
      }),
    );
    const delivered = parseWrites(res.writes) as Array<{ type?: unknown }>;
    assert.deepEqual(
      delivered.map((f) => f.type),
      ['message.part.updated'],
      'abort must not emit stream.error',
    );
  });
});

describe('relaySse C0 wire contract (heartbeat/id/stream.error)', () => {
  it('exposes HEARTBEAT_MS = 15s and registers + clears exactly one heartbeat timer', async () => {
    assert.equal(HEARTBEAT_MS, 15_000);
    const req = fakeReq();
    const res = fakeRes();
    const intervals: Array<{ delay: number }> = [];
    let cleared = 0;
    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    (globalThis as Record<string, unknown>).setInterval = ((cb: () => void, ms?: number) => {
      intervals.push({ delay: ms ?? 0 });
      return origSetInterval(cb, ms);
    }) as typeof setInterval;
    (globalThis as Record<string, unknown>).clearInterval = ((t: unknown) => {
      cleared += 1;
      return origClearInterval(t as ReturnType<typeof setInterval>);
    }) as typeof clearInterval;
    try {
      await relaySse(
        baseParams({
          req,
          res,
          subscribe: async () => streamOf(FRAMES),
        }),
      );
    } finally {
      (globalThis as Record<string, unknown>).setInterval = origSetInterval;
      (globalThis as Record<string, unknown>).clearInterval = origClearInterval;
    }
    assert.equal(intervals.length, 1, 'exactly one heartbeat timer per stream');
    assert.equal(intervals[0]?.delay, HEARTBEAT_MS);
    assert.ok(cleared >= 1, 'the heartbeat timer must be cleared in finally (no leak)');
  });

  it('heartbeat callback writes `: ping` without touching the frame flow', async () => {
    const req = fakeReq();
    const res = fakeRes();
    let heartbeatCb: (() => void) | null = null;
    const origSetInterval = globalThis.setInterval;
    (globalThis as Record<string, unknown>).setInterval = ((cb: () => void, ms?: number) => {
      heartbeatCb = cb;
      return origSetInterval(cb, ms);
    }) as typeof setInterval;
    // A stream that stays open until we release it: the heartbeat fires mid-stream.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hanging = {
      stream: {
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
          yield FRAMES[0];
          await gate;
        },
      },
    } satisfies SseSubscription;
    try {
      const pending = relaySse(
        baseParams({
          req,
          res,
          subscribe: async () => hanging,
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(heartbeatCb, 'heartbeat timer must be armed after flushHeaders');
      (heartbeatCb as unknown as () => void)();
      (heartbeatCb as unknown as () => void)();
      assert.deepEqual(
        res.writes.filter((w) => w.startsWith(': ping')),
        [': ping\n\n', ': ping\n\n'],
        'idle heartbeats must flow as bare comments',
      );
      // The frame already delivered keeps its id:/event:/data: shape.
      assert.deepEqual(parseWrites(res.writes), [FRAMES[0]]);
      release();
      await pending;
    } finally {
      (globalThis as Record<string, unknown>).setInterval = origSetInterval;
    }
    assert.equal(res.writableEnded, true);
  });

  it('emits `event: message` on every data frame', async () => {
    const req = fakeReq();
    const res = fakeRes();
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf(FRAMES),
      }),
    );
    const dataChunks = res.writes.filter((w) => w.includes('data:'));
    assert.equal(dataChunks.length, 3);
    for (const chunk of dataChunks) {
      assert.ok(chunk.includes('event: message'), `missing event line in ${JSON.stringify(chunk)}`);
    }
  });

  it('omits the id: line for id-less frames (empty string / non-string id)', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const frames = [
      { type: 'x', data: {} },
      { id: '', type: 'x', data: {} },
      { id: 42, type: 'x', data: {} },
      { id: null, type: 'x', data: {} },
    ];
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf(frames),
      }),
    );
    assert.equal(res.writes.length, 4);
    for (const chunk of res.writes) {
      assert.ok(!chunk.startsWith('id:'), `id-less frame must not carry id:, got ${JSON.stringify(chunk)}`);
      assert.ok(chunk.startsWith('data:'), `id-less frame must stay a bare data frame`);
    }
    assert.equal(res.writableEnded, true);
  });

  it('stream.error carries the terminal shape (id prefix, type, message) then ends', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const failing = {
      stream: {
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
          throw new Error('runner exploded');
        },
      },
    } satisfies SseSubscription;
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => failing,
      }),
    );
    assert.equal(res.writes.length, 1);
    const chunk = res.writes[0] ?? '';
    assert.ok(chunk.includes('event: message'), 'terminal frame rides the same event channel');
    const bodies = parseWrites(res.writes) as Array<{
      id?: unknown;
      type?: unknown;
      data?: { message?: unknown };
    }>;
    assert.equal(bodies[0]?.type, 'stream.error');
    assert.equal(bodies[0]?.data?.message, 'runner exploded');
    assert.ok(
      typeof bodies[0]?.id === 'string' && (bodies[0]?.id as string).startsWith('stream-error-'),
      'terminal id must be synthetic stream-error-* (never a replayable cursor)',
    );
    assert.ok(chunk.startsWith(`id: ${bodies[0]?.id}`), 'terminal frame mirrors its id: line');
    assert.equal(res.writableEnded, true);
  });

  it('stream.error falls back to "stream interrupted" for message-less / non-Error throws', async () => {
    for (const thrown of [new Error(), 'plain string boom', null, undefined, 42]) {
      const req = fakeReq();
      const res = fakeRes();
      const failing = {
        stream: {
          async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
            throw thrown;
          },
        },
      } satisfies SseSubscription;
      await relaySse(
        baseParams({
          req,
          res,
          subscribe: async () => failing,
        }),
      );
      const bodies = parseWrites(res.writes) as Array<{
        type?: unknown;
        data?: { message?: unknown };
      }>;
      assert.equal(bodies.length, 1, `expected one terminal frame for ${String(thrown)}`);
      assert.equal(bodies[0]?.type, 'stream.error');
      assert.equal(bodies[0]?.data?.message, 'stream interrupted');
      assert.equal(res.writableEnded, true);
    }
  });

  it('a throwing mapFrame becomes stream.error (never silent, never a leak)', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const logs: Array<string> = [];
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf(FRAMES),
        logger: captureLogger(logs),
        mapFrame: () => {
          throw new Error('serializer blew up');
        },
      }),
    );
    const bodies = parseWrites(res.writes) as Array<{ type?: unknown }>;
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.type, 'stream.error');
    assert.equal(res.writableEnded, true);
  });

  it('a throwing filterFrame becomes stream.error (error propagation, not a drop)', async () => {
    const req = fakeReq();
    const res = fakeRes();
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => streamOf(FRAMES),
        filterFrame: () => {
          throw new Error('predicate blew up');
        },
      }),
    );
    const bodies = parseWrites(res.writes) as Array<{ type?: unknown }>;
    assert.equal(bodies[bodies.length - 1]?.type, 'stream.error');
    assert.equal(res.writableEnded, true);
  });

  it('probe down throws before any header/write/end', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const params = baseParams({
      req,
      res,
      subscribe: async () => streamOf(FRAMES),
    });
    params.probe = async () => 'down';
    const err = await relaySse(params).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error && (err as Error).message === 'unreachable');
    assert.deepEqual(res.writes, []);
    assert.deepEqual(res.headers, {});
    assert.equal(res.writableEnded, false);
  });

  it('subscribe AbortError is a quiet disconnect (no throw, no frame, no end-write)', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const abort = new Error('gone');
    abort.name = 'AbortError';
    await relaySse(
      baseParams({
        req,
        res,
        subscribe: async () => {
          throw abort;
        },
      }),
    );
    assert.deepEqual(res.writes, []);
  });
});

describe('isAbortError hostile inputs', () => {
  it('matches name/code/cause shapes, rejects everything else', () => {
    const abort = new Error('x');
    abort.name = 'AbortError';
    assert.equal(isAbortError(abort), true);
    assert.equal(isAbortError({ code: 20 }), true);
    assert.equal(isAbortError({ cause: { name: 'AbortError' } }), true);
    assert.equal(isAbortError({ cause: { code: 20 } }), true);
    for (const hostile of [
      null,
      undefined,
      0,
      42,
      '',
      'AbortError',
      [],
      {},
      { name: 'Error', code: 500 },
      { name: 'aborterror' },
      { code: '20' },
      { cause: null },
      { cause: 'AbortError' },
    ]) {
      assert.equal(isAbortError(hostile), false, `must reject ${JSON.stringify(hostile)}`);
    }
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
