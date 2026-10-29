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
 * {projectId,text}, provider envelope unwrap + drift, and the SSE frame
 * parser (data: frames → SessionStreamFrame, heartbeats skipped, malformed
 * frame throws).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
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
import { ApiClientError } from '../client';
const {
  fetchRunnerProviders,
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
  directory: '/srv/projects/p1',
  projectId: PROJECT,
  model: null,
  // as const: { type: string } would not satisfy SessionRunStatus asserts.
  status: { type: 'busy' } as const,
};

describe('sessions-client domain boundary', () => {
  test('listSessions: domain rows pass the schema (title:null preserved), Bearer travels', async () => {
    stubs = [{ status: 200, body: [ROW] }];
    const rows = await listSessions(PROJECT);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(ROW);
    expect(calls[0]?.url).toContain(`/api/sessions?projectId=${PROJECT}`);
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

  test('fetchRunnerProviders: v2 envelope {data:[...]} unwrapped; drift fails loud', async () => {
    stubs = [{ status: 200, body: { location: {}, data: [{ id: 'p1', name: 'One' }] } }];
    const rows = await fetchRunnerProviders({ projectId: PROJECT });
    expect(rows).toEqual([{ id: 'p1', name: 'One' }]);

    stubs = [{ status: 200, body: { nonsense: true } }];
    const err = await fetchRunnerProviders({ projectId: PROJECT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('shape_mismatch');
  });

  test('sessionEventStream: data: frames parse to domain rows, heartbeats skipped, malformed frame throws', async () => {
    const sse = [
      'data: {"id":"e1","type":"message.part.delta","data":{"sessionID":"ses_1","messageID":"m","partID":"p","field":"text","delta":"Hi"},"session":"ses_1"}\n\n',
      ': heartbeat\n\n',
      'data: {"id":"e2","type":"session.idle","data":{"sessionID":"ses_1"},"session":"ses_1"}\n\n',
    ].join('');
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const frames = [];
    for await (const frame of sessionEventStream(PROJECT, ctrl.signal)) {
      frames.push(frame);
      if (frames.length === 2) break;
    }
    ctrl.abort();
    expect(frames[0]?.type).toBe('message.part.delta');
    expect(frames[0]?.session).toBe('ses_1');
    expect(frames[1]?.type).toBe('session.idle');

    // Malformed frame (id missing) — fails loud, never a silent skip.
    globalThis.fetch = (async () =>
      new Response('data: {"type":"x","data":{}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    const ctrl2 = new AbortController();
    const err = await (async () => {
      // eslint-disable-next-line no-unreachable-loop
      for await (const _f of sessionEventStream(PROJECT, ctrl2.signal)) return _f;
      return null;
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
