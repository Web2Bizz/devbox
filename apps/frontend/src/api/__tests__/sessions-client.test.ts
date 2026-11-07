/**
 * sessions-client — real facade tests (api/client.ts + api/sessions-client.ts
 * with a stubbed global fetch and a mocked auth-store). The point is the
 * DOMAIN BOUNDARY: answers are parsed with @rush-code/contracts schemas and
 * a wire drift fails loud, while auth keeps the honest semantics.
 *
 * Covers: listSessions parses domain rows (title:null passes, missing field
 * → shape_mismatch, NOT a silent cast), the gate codes stay raw (400
 * PROJECT_REQUIRED / 404 not_found never map to SessionExpiredError), the
 * 401 flow (one silent refresh retry; spent refresh → SessionExpiredError;
 * no session → SessionExpiredError without network), send body exactly
 * {projectId,text}, the domain interrupt (body {projectId}, answer
 * {interrupted} parsed, drift loud) and the domain provider inventory
 * (required rows parse, non-contract members stripped), and the SSE frame
 * parser (data: frames → SessionStreamFrame, heartbeats skipped, malformed
 * frame skipped fail-soft with the stream alive).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // second register() throws — ignore.
}

// ---- auth-store mock (mutable) --------------------------------------------
const authHolder: {
  access: string | null;
  refreshResult: string | null;
  refreshCalls: number;
} = { access: 'token-1', refreshResult: 'token-2', refreshCalls: 0 };

mock.module('../../lib/auth-store', () => ({
  getValidAccessToken: async () => authHolder.access,
  refreshAccessToken: async () => {
    authHolder.refreshCalls += 1;
    return authHolder.refreshResult;
  },
  getAccessToken: () => authHolder.access,
}));

// Static import: ApiClientError is used as a TYPE too (an await-import
// binding is value-only). client.ts has no auth imports, so hoisting above
// the auth-store mock is safe; sessions-client stays a mock-first dynamic
// import below.
import { ApiClientError, SEND_TIMEOUT_MS } from '../client';
const {
  interruptSession,
  listAgents,
  listSessionProviders,
  listSessions,
  sendSessionMessage,
  sessionEventStream,
} = await import('../sessions-client');

// ---- fetch stub ------------------------------------------------------------
type Stub = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};
let stubs: Stub[] = [];
const calls: Array<{ url: string; init: RequestInit }> = [];

function jsonResponse(stub: Stub): Response {
  return new Response(JSON.stringify(stub.body), {
    status: stub.status,
    headers: { 'content-type': 'application/json', ...(stub.headers ?? {}) },
  });
}

beforeEach(() => {
  stubs = [];
  calls.length = 0;
  authHolder.access = 'token-1';
  authHolder.refreshResult = 'token-2';
  authHolder.refreshCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const stub = stubs.shift() ?? { status: 200, body: {} };
    return jsonResponse(stub);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  // no leaks between tests
  stubs = [];
});

const PROJECT = '123e4567-e89b-12d3-a456-426614174090';

const ROW = {
  id: 'ses_1',
  title: null,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T11:00:00.000Z',
  directory: '/srv/projects/p1',
  projectId: PROJECT,
  model: null,
  agentId: null,
  // as const: { type: string } would not satisfy SessionRunStatus asserts.
  status: { type: 'busy' } as const,
};

describe('sessions-client domain boundary', () => {
  test('listSessions: domain rows pass the schema (title:null preserved), Bearer travels', async () => {
    stubs = [{ status: 200, body: [ROW] }];
    const rows = await listSessions(PROJECT);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(ROW);
    expect(calls[0]?.url).toContain(`/api/v1/sessions?projectId=${PROJECT}`);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token-1');
    expect(headers['x-correlation-id']).toBeTruthy();
  });

  test('shape drift: a row without createdAt fails loud as shape_mismatch (never a cast)', async () => {
    stubs = [{ status: 200, body: [{ id: 'ses_1' }] }];
    const err = await listSessions(PROJECT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('shape_mismatch');
  });

  test('shape drift: a row without updatedAt fails loud as shape_mismatch (no silent fallback)', async () => {
    const { createdAt: _created, ...rest } = ROW;
    void _created;
    const { updatedAt: _updated, ...withoutUpdatedAt } = rest;
    void _updated;
    stubs = [{ status: 200, body: [withoutUpdatedAt] }];
    const err = await listSessions(PROJECT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('shape_mismatch');
  });

  test('honest 400/404 propagate raw — SessionExpiredError never fires on gate codes', async () => {
    stubs = [{ status: 400, body: { code: 'PROJECT_REQUIRED', message: 'projectId is required' } }];
    const err400 = await listSessions('').catch((e: unknown) => e);
    expect(err400).toBeInstanceOf(ApiClientError);
    expect((err400 as ApiClientError).status).toBe(400);
    expect((err400 as ApiClientError).name).toBe('ApiClientError');
    expect((err400 as Error).name).not.toBe('SessionExpiredError');

    stubs = [{ status: 404, body: { code: 'not_found', message: 'Project not found' } }];
    const err404 = await listSessions(PROJECT).catch((e: unknown) => e);
    expect((err404 as ApiClientError).status).toBe(404);
    expect((err404 as ApiClientError).code).toBe('not_found');
  });

  test('401 path: one silent refresh retry; spent refresh → SessionExpiredError', async () => {
    stubs = [
      { status: 401, body: { code: 'unauthorized', message: 'expired' } },
      { status: 200, body: [ROW] },
    ];
    const rows = await listSessions(PROJECT);
    expect(rows.length).toBe(1);
    expect(authHolder.refreshCalls).toBe(1);
    expect(calls.length).toBe(2);
    const retryHeaders = calls[1]?.init.headers as Record<string, string>;
    expect(retryHeaders.authorization).toBe('Bearer token-2');

    authHolder.refreshResult = null;
    stubs = [{ status: 401, body: { code: 'unauthorized', message: 'expired' } }];
    const err = await listSessions(PROJECT).catch((e: unknown) => e);
    expect((err as Error).name).toBe('SessionExpiredError');
  });

  test('no session: SessionExpiredError before any network', async () => {
    authHolder.access = null;
    const err = await listSessions(PROJECT).catch((e: unknown) => e);
    expect((err as Error).name).toBe('SessionExpiredError');
    expect(calls.length).toBe(0);
  });

  test('sendSessionMessage: body is exactly {projectId,text} (domain SendMessageRequest)', async () => {
    stubs = [
      {
        status: 200,
        body: {
          id: 'msg_q',
          type: 'user',
          createdAt: '2026-10-29T10:01:00.000Z',
          text: 'hi',
        },
      },
    ];
    const receipt = await sendSessionMessage(PROJECT, 'ses_1', 'hi');
    expect(receipt.id).toBe('msg_q');
    expect(receipt.text).toBe('hi');
    const init = calls[0]?.init as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ projectId: PROJECT, text: 'hi' });
  });

  test('sendSessionMessage: agentId rides the body when the picker set one', async () => {
    stubs = [
      {
        status: 200,
        body: {
          id: 'msg_q',
          type: 'user',
          createdAt: '2026-10-29T10:01:00.000Z',
          text: 'hi',
        },
      },
    ];
    await sendSessionMessage(PROJECT, 'ses_1', 'hi', { agentId: 'ask' });
    const init = calls[0]?.init as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ projectId: PROJECT, text: 'hi', agentId: 'ask' });
  });

  test('sendSessionMessage: long default timeout (whole-turn wait), custom override forwards', async () => {
    expect(SEND_TIMEOUT_MS).toBe(600_000);
    const receiptBody = {
      id: 'msg_q',
      type: 'user',
      createdAt: '2026-10-29T10:01:00.000Z',
      text: 'hi',
    };
    const delays: unknown[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
        delays.push(ms);
        return (origSetTimeout as (...a: unknown[]) => unknown)(cb, ms, ...rest);
      }) as typeof setTimeout,
    );
    try {
      stubs = [{ status: 200, body: receiptBody }];
      await sendSessionMessage(PROJECT, 'ses_1', 'hi');
      expect(delays.at(-1)).toBe(SEND_TIMEOUT_MS);

      stubs = [{ status: 200, body: receiptBody }];
      await sendSessionMessage(PROJECT, 'ses_1', 'hi', { timeoutMs: 5_000 });
      expect(delays.at(-1)).toBe(5_000);
    } finally {
      timerSpy.mockRestore();
    }
  });

  test('listAgents: registry rows parse, drift fails loud (never a cast)', async () => {
    stubs = [
      {
        status: 200,
        body: [{ id: 'ask', name: 'Ask', description: 'Answers user questions' }],
      },
    ];
    const rows = await listAgents();
    expect(rows).toEqual([{ id: 'ask', name: 'Ask', description: 'Answers user questions' }]);
    expect(calls[0]?.url).toContain('/api/v1/agents');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token-1');

    stubs = [{ status: 200, body: [{ id: 'ask' }] }];
    const err = await listAgents().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('shape_mismatch');
  });

  test('interruptSession: domain POST with {projectId} body, answer {interrupted} parsed', async () => {
    stubs = [{ status: 200, body: { interrupted: false } }];
    const res = await interruptSession(PROJECT, 'ses_1');
    expect(res).toEqual({ interrupted: false });
    const init = calls[0]?.init as RequestInit;
    expect(init.method).toBe('POST');
    expect(calls[0]?.url).toContain('/api/v1/sessions/ses_1/interrupt');
    expect(JSON.parse(String(init.body))).toEqual({ projectId: PROJECT });

    // Drift: interrupted missing is a contract bug, never a default to false.
    stubs = [{ status: 200, body: {} }];
    const err = await interruptSession(PROJECT, 'ses_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('shape_mismatch');
  });

  test('listSessionProviders: domain rows parsed; credential-bearing extras dropped, drift fails loud', async () => {
    // zod strips non-contract members (settings/headers never reach the UI),
    // the required fields still parse.
    stubs = [
      {
        status: 200,
        body: [
          {
            id: 'p1',
            name: 'One',
            activation: 'enabled',
            package: '@p/one',
            headers: { authorization: 'should-never-travel' },
          },
        ],
      },
    ];
    const rows = await listSessionProviders(PROJECT);
    expect(rows).toEqual([{ id: 'p1', name: 'One', activation: 'enabled', package: '@p/one' }]);
    expect(JSON.stringify(rows)).not.toContain('should-never-travel');
    expect(calls[0]?.url).toContain(`/api/v1/sessions/providers?projectId=${PROJECT}`);

    stubs = [{ status: 200, body: [{ id: 'p1', name: 'One', activation: 'weird', package: '' }] }];
    const err = await listSessionProviders(PROJECT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('shape_mismatch');
  });

  test('sessionEventStream: data: frames parse to domain rows, heartbeats skipped, malformed frame skipped (fail-soft)', async () => {
    const sse = [
      'data: {"id":"e1","type":"message.part.delta","data":{"sessionID":"ses_1","messageID":"m","partID":"p","field":"text","delta":"Hi"},"session":"ses_1"}\n\n',
      ': ping\n\n',
      'data: {"id":"e2","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n',
    ].join('');
    let activity = 0;
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal, {
      onActivity: () => {
        activity += 1;
      },
    })) {
      frames.push(frame);
      if (frames.length === 2) break;
    }
    ctrl.abort();
    expect(frames[0]?.type).toBe('message.part.delta');
    expect(frames[0]?.session).toBe('ses_1');
    expect(frames[1]?.type).toBe('session.idle');
    // 2 frames + 1 heartbeat all count as activity for the watchdog.
    expect(activity).toBe(3);

    // Malformed frame (id missing) — skipped fail-soft, the stream stays alive.
    globalThis.fetch = (async () =>
      new Response(
        'data: {"type":"x","data":{}}\n\n' +
          'data: {"id":"e9","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      )) as unknown as typeof fetch;
    const ctrl2 = new AbortController();
    const frames2 = [];
    for await (const f of sessionEventStream(PROJECT, ctrl2.signal)) {
      frames2.push(f);
      if (frames2.length === 1) break;
    }
    ctrl2.abort();
    expect(frames2.length).toBe(1);
    expect(frames2[0]?.id).toBe('e9');
  });

  test('sessionEventStream: broken-json and broken-schema chunks are skipped, good frames survive', async () => {
    const sse = [
      'data: {"id":"g1","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n',
      'data: {"id":"broken-json",\n\n',
      'data: {"id":"g2","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n',
      'data: {"type":"x","data":{}}\n\n',
      'data: {"id":"g3","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n',
      ': ping\n\n',
    ].join('');
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal)) {
      frames.push(frame);
      if (frames.length === 3) break;
    }
    ctrl.abort();
    // The broken-json chunk and the schema-violating chunk (missing id) are
    // skipped fail-soft; the 3 good frames arrive in order, stream never dies.
    expect(frames.map((f) => f.id)).toEqual(['g1', 'g2', 'g3']);
  });

  test('sessionEventStream: ?session= and Last-Event-ID travel on the wire', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return new Response(': ping\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const ctrl = new AbortController();
    for await (const _f of sessionEventStream(PROJECT, ctrl.signal, {
      sessionId: 'ses_A',
      lastEventId: 'e42',
    })) {
      break;
    }
    ctrl.abort();
    expect(seen[0]?.url).toContain('projectId=');
    expect(seen[0]?.url).toContain('session=ses_A');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBe('e42');
  });

  test('sessionEventStream: multi-line data: chunk joins into one frame (no stream death)', async () => {
    const sse = [
      'data: {"id":"e1","type":"message.part.delta",\n',
      'data: "data":{"sessionID":"ses_1","messageID":"m","partID":"p","field":"text","delta":"Hi"},"session":"ses_1"}\n\n',
    ].join('');
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal)) {
      frames.push(frame);
      if (frames.length === 1) break;
    }
    ctrl.abort();
    expect(frames.length).toBe(1);
    expect(frames[0]?.type).toBe('message.part.delta');
    expect(frames[0]?.session).toBe('ses_1');
  });

  test('sessionEventStream: id:-only + CRLF heartbeat dispatches are liveness (activity, no frame)', async () => {
    const sse = 'id: e5\n: ping\n\n'.replace(/\n/g, '\r\n') +
      'data: {"id":"g1","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\r\n\r\n' +
      ': ping\n\n';
    let activity = 0;
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal, {
      onActivity: () => {
        activity += 1;
      },
    })) {
      frames.push(frame);
      if (frames.length === 1) break;
    }
    ctrl.abort();
    expect(frames.map((f) => f.id)).toEqual(['g1']);
    // id-only dispatch + the good frame count; trailing :ping after break is never read (generator semantics).
    expect(activity).toBe(2);
  });

  test('sessionEventStream: empty data:/whitespace chunks never yield, stream stays alive', async () => {
    const sse = 'data:\n\n   \n\n' +
      'data:   \n\n' +
      'data: {"id":"g1","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n';
    let activity = 0;
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal, {
      onActivity: () => {
        activity += 1;
      },
    })) {
      frames.push(frame);
      if (frames.length === 1) break;
    }
    ctrl.abort();
    expect(frames.map((f) => f.id)).toEqual(['g1']);
    // Two empty data: payloads count as activity; pure whitespace does not.
    expect(activity).toBe(3);
  });

  test('sessionEventStream: hostile JSON payloads (null/number/array/string) are skipped', async () => {
    const sse = [
      'data: null\n\n',
      'data: 42\n\n',
      'data: [1,2]\n\n',
      'data: "just a string"\n\n',
      'data: true\n\n',
      'data: {"id":"g1","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n',
    ].join('');
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal)) {
      frames.push(frame);
      if (frames.length === 1) break;
    }
    ctrl.abort();
    expect(frames.map((f) => f.id)).toEqual(['g1']);
  });

  test('sessionEventStream: envelope violations (empty id/type, missing data) are skipped', async () => {
    const sse = [
      'data: {"id":"","type":"session.idle","data":{"sessionID":"s"},"session":"s"}\n\n',
      'data: {"id":"x","type":"","data":{}}\n\n',
      'data: {"id":"y","type":"session.idle"}\n\n',
      'data: {"type":"session.idle","data":{}}\n\n',
      'data: {"id":"g1","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n',
    ].join('');
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal)) {
      frames.push(frame);
      if (frames.length === 1) break;
    }
    ctrl.abort();
    expect(frames.map((f) => f.id)).toEqual(['g1']);
  });

  test('sessionEventStream: unknown future frame types pass the permissive envelope', async () => {
    const sse = 'data: {"id":"f1","type":"custom.future.v9","data":{"anything":1},"session":"ses_1"}\n\n';
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal)) {
      frames.push(frame);
      if (frames.length === 1) break;
    }
    ctrl.abort();
    // The envelope stays forward-compatible: unknown types yield, never drop.
    expect(frames[0]?.type).toBe('custom.future.v9');
    expect(frames[0]?.id).toBe('f1');
  });

  test('sessionEventStream: a frame split across TCP reads still parses once complete', async () => {
    const full = 'data: {"id":"e1","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n';
    const cut = 37;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(full.slice(0, cut)));
        c.enqueue(new TextEncoder().encode(full.slice(cut)));
        c.close();
      },
    });
    globalThis.fetch = (async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal)) {
      frames.push(frame);
      if (frames.length === 1) break;
    }
    ctrl.abort();
    expect(frames.map((f) => f.id)).toEqual(['e1']);
  });

  test('sessionEventStream: huge delta payloads survive intact', async () => {
    const big = 'x'.repeat(200_000);
    const sse = `data: {"id":"big","type":"session.idle","data":{"sessionID":"ses_1","blob":"${big}"},"session":"ses_1"}\n\n`;
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal)) {
      frames.push(frame);
      if (frames.length === 1) break;
    }
    ctrl.abort();
    expect(frames.length).toBe(1);
    expect((frames[0]?.data as Record<string, unknown>).blob).toBe(big);
  });

  test('sessionEventStream: transport failures throw outward (fetch throw, null body)', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const errFetch = await sessionEventStream(PROJECT, ctrl.signal).next().catch((e: unknown) => e);
    expect(errFetch).toBeInstanceOf(TypeError);
    ctrl.abort();

    globalThis.fetch = (async () =>
      ({ ok: true, body: null, headers: new Headers() }) as unknown as Response) as unknown as typeof fetch;
    const ctrl2 = new AbortController();
    const errBody = await sessionEventStream(PROJECT, ctrl2.signal).next().catch((e: unknown) => e);
    expect(errBody).toBeInstanceOf(ApiClientError);
    expect((errBody as ApiClientError).code).toBe('no_stream_body');
    ctrl2.abort();
  });

  test('sessionEventStream: without opts no session param and no Last-Event-ID travel', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return new Response(': ping\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const ctrl = new AbortController();
    for await (const _f of sessionEventStream(PROJECT, ctrl.signal)) {
      break;
    }
    ctrl.abort();
    expect(seen[0]?.url).toContain('projectId=');
    expect(seen[0]?.url).not.toContain('session=');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBeUndefined();
  });

  test('sessionEventStream: session ids are URL-encoded on the wire', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return new Response(': ping\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const ctrl = new AbortController();
    for await (const _f of sessionEventStream(PROJECT, ctrl.signal, { sessionId: 'ses A/B?c' })) {
      break;
    }
    ctrl.abort();
    expect(new URL(seen[0]?.url).searchParams.get('session')).toBe('ses A/B?c');
  });
});
