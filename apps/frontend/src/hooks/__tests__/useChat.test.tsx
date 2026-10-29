/**
 * useChat — streamed single-session chat over the DOMAIN /api/sessions*
 * contract (api/sessions-client is the only transport; the frontend knows
 * nothing about the underlying runner).
 *
 * Covers: append (user row + assistant answer committed from streamed
 * message.part.delta frames on session.idle), SSE filter (frames of other
 * sessions ignored; message.part.updated appends snapshot growth only),
 * history parsing (domain rows: text:null variants skipped, assistant/user
 * roles from `type`), stop-abort (partial committed, server interrupt
 * alias fires best-effort, sending clears), error+retry (queue failure
 * surfaces, reload clears + refetches history), unmount cleanup (stream
 * signal aborted, no state after unmount), project gate (no projectId →
 * honest PROJECT_REQUIRED, no network).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

// ---- domain sessions-client mock (same specifier shape the hook imports) --
const PROJECT = { projectId: '00000000-0000-0000-0000-000000000001' };

const sessionInfo = (id: string) => ({
  id,
  title: null,
  createdAt: new Date(1700000000000).toISOString(),
  directory: '/srv/projects/p1',
  projectId: PROJECT.projectId,
  model: null,
  status: { type: 'idle' as const },
});

const createMock = mock(async (_body?: unknown, _opts?: unknown) => sessionInfo('ses-1'));
let sendImpl: (projectId: string, sessionId: string, text: string, opts?: unknown) => Promise<unknown> =
  async (_p, _s, text) => ({
    id: 'msg-q1',
    type: 'user',
    createdAt: new Date(1700000001000).toISOString(),
    text,
  });
const sendMock = mock((p: string, s: string, text: string, opts?: unknown) => sendImpl(p, s, text, opts));
const messagesImplHolder: { fn: (projectId: string, sessionId: string) => Promise<unknown[]> } = {
  fn: async () => [],
};
const messagesMock = mock((p: string, s: string) => messagesImplHolder.fn(p, s));
// Domain interrupt answer per the artifact SessionInterruptResponse.
const abortMock = mock(async (_projectId: string, _sessionId: string) => ({ interrupted: true }));

// A live-bus stand-in: the generator starts at mount and blocks until
// frames arrive (pushed by the test after send()), mirroring a real SSE —
// frames are consumed only while a session is bound.
const queue: unknown[] = [];
function pushFrames(frames: unknown[]): void {
  for (const f of frames) queue.push(f);
}
let seenSignals: AbortSignal[] = [];
async function* makeStream(_projectId: string, signal: AbortSignal) {
  seenSignals.push(signal);
  for (;;) {
    if (signal.aborted) return;
    if (queue.length > 0) {
      yield queue.shift();
      continue;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
const streamMock = mock((projectId: string, signal: AbortSignal) => makeStream(projectId, signal));

mock.module('../../api/sessions-client', () => ({
  ensureSessionAuth: async () => {},
  createSession: (body: unknown, opts?: unknown) => createMock(body, opts),
  sendSessionMessage: (p: string, s: string, text: string, opts?: unknown) =>
    sendMock(p, s, text, opts),
  listSessionMessages: (p: string, s: string) => messagesMock(p, s),
  interruptSession: (p: string, s: string) => abortMock(p, s),
  sessionEventStream: (projectId: string, signal: AbortSignal) => streamMock(projectId, signal),
  toErrorMessage: (e: unknown) => {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object' && 'message' in (e as Record<string, unknown>)) {
      return String((e as Record<string, unknown>).message);
    }
    return 'Unexpected error';
  },
}));

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { useChat } = await import('../useChat');

const delta = (session: string, text: string, partId = 'prt-1') => ({
  id: `evt-${text}-${partId}`,
  type: 'message.part.delta',
  data: { sessionID: session, messageID: 'msg-1', partID: partId, field: 'text', delta: text },
  session,
});
const updated = (session: string, text: string, partId = 'prt-1') => ({
  id: `evt-upd-${text}-${partId}`,
  type: 'message.part.updated',
  data: { sessionID: session, part: { id: partId, type: 'text', text } },
  session,
});
const idle = (session: string) => ({
  id: `evt-idle-${session}`,
  type: 'session.idle',
  data: { sessionID: session },
  session,
});

const settle = async (rounds = 8) => {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
};

afterEach(() => {
  cleanup();
  queue.length = 0;
  seenSignals = [];
  createMock.mockClear();
  sendMock.mockClear();
  messagesMock.mockClear();
  abortMock.mockClear();
  streamMock.mockClear();
  sendImpl = async (_p, _s, text) => ({
    id: 'msg-q1',
    type: 'user',
    createdAt: new Date(1700000001000).toISOString(),
    text,
  });
  messagesImplHolder.fn = async () => [];
});

describe('useChat (domain)', () => {
  test('append: send() queues, streamed deltas commit the assistant row on session.idle', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    // The session exists after create resolves (microtask); the bus then
    // consumes these domain frames.
    pushFrames([delta('ses-1', 'hello'), delta('ses-1', ' back'), idle('ses-1')]);
    await settle(16);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'hello' });
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'hello back' });
    expect(result.current.isEmpty).toBe(false);
  });

  test('SSE filter: other-session frames ignored; updated snapshot appends growth only', async () => {
    const { result } = renderHook(() => useChat({ sessionId: 'ses-1', ...PROJECT }));
    await settle();

    await act(async () => {
      await result.current.send('go');
    });
    // `sending` is set — now the bus delivers domain frames for ses-1.
    pushFrames([
      delta('ses-other', 'NOT ME'),
      updated('ses-1', 'part one', 'prt-9'),
      updated('ses-1', 'part one two', 'prt-9'),
      idle('ses-1'),
    ]);
    await settle(16);

    expect(result.current.messages.length).toBe(2);
    // user row + assistant snapshot; other-session delta never streamed
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'go' });
    // snapshot growth: 'part one' then only ' two' appended (no duplication)
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'part one two',
    });
  });

  test('history: domain rows parse to chat rows, text:null variants skipped', async () => {
    messagesImplHolder.fn = async () => [
      {
        id: 'm1',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'scoped hi',
      },
      {
        id: 'm2',
        type: 'shell',
        createdAt: new Date(1700000000500).toISOString(),
        text: null,
      },
      {
        id: 'm3',
        type: 'assistant',
        createdAt: new Date(1700000001000).toISOString(),
        text: 'scoped hello back',
      },
    ];

    const { result } = renderHook(() => useChat({ sessionId: 'ses-99', ...PROJECT }));
    await settle();

    // Scoped mode loads the domain thread without creating a session.
    expect(messagesMock).toHaveBeenCalledTimes(1);
    expect(messagesMock.mock.calls[0]?.[1]).toBe('ses-99');
    expect(createMock).not.toHaveBeenCalled();
    expect(result.current.sessionId).toBe('ses-99');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'scoped hi' });
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'scoped hello back',
    });
  });

  test('stop-abort: stop() commits the partial stream and fires the best-effort interrupt', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('long task');
    });
    pushFrames([delta('ses-1', 'half an answer')]);
    await settle(16);

    act(() => {
      result.current.stop();
    });
    await settle();

    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(abortMock.mock.calls[0]?.[0]).toBe(PROJECT.projectId);
    expect(abortMock.mock.calls[0]?.[1]).toBe('ses-1');
    expect(result.current.sending).toBe(false);
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'half an answer' });
    // The stream itself is NOT closed by stop() (it serves the next turn);
    // unmount abort is covered by the cleanup test.
  });

  test('error+retry: queue failure surfaces (raw message, no masking), reload refetches history', async () => {
    sendImpl = async () => {
      throw new Error('boom');
    };
    messagesImplHolder.fn = async () => [
      {
        id: 'm1',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'hi',
      },
    ];

    const { result } = renderHook(() => useChat({ sessionId: 'ses-77', ...PROJECT }));
    await settle();

    await act(async () => {
      await result.current.send('hi');
    });
    await settle();
    expect(result.current.error).toBe('boom');
    expect(result.current.sending).toBe(false);

    sendImpl = async (_p, _s, text) => ({
      id: 'msg-q2',
      type: 'user',
      createdAt: new Date(1700000002000).toISOString(),
      text,
    });
    act(() => {
      result.current.reload();
    });
    await settle();

    expect(result.current.error).toBeNull();
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'hi' });
  });

  test('unmount cleanup: the stream AbortSignal fires, no reconnect storm', async () => {
    const { unmount } = renderHook(() => useChat({ ...PROJECT }));
    await settle();
    expect(streamMock).toHaveBeenCalled();

    unmount();
    await settle();
    expect(seenSignals.at(-1)?.aborted).toBe(true);
  });

  test('project gate: send() without projectId surfaces PROJECT_REQUIRED without network', async () => {
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.send('hello');
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(result.current.error).toContain('project-scoped');
  });

  test('streaming: non-text deltas skipped, delta+snapshot interleave without duplication', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    const thinking = {
      id: 'evt-think',
      type: 'message.part.delta',
      data: {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 'prt-1',
        field: 'thinking',
        delta: 'NOT CHAT',
      },
      session: 'ses-1',
    };
    pushFrames([
      thinking,
      delta('ses-1', 'Hel'),
      updated('ses-1', 'Hello', 'prt-1'),
      delta('ses-1', ' world'),
      idle('ses-1'),
    ]);
    await settle(16);

    expect(result.current.sending).toBe(false);
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'Hello world' });
  });

  test('model: picked model rides lazy create + prompt, survives reload', async () => {
    const picked = { providerID: 'prov-openai', id: 'model-m' };
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      result.current.setModel(picked);
    });
    act(() => {
      void result.current.send('hi');
    });
    pushFrames([delta('ses-1', 'yo'), idle('ses-1')]);
    await settle(16);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[1]).toMatchObject({ model: picked });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[3]).toMatchObject({ model: picked });
    expect(result.current.model).toMatchObject(picked);

    act(() => {
      result.current.reload();
    });
    await settle();
    // reload refetches history + redials SSE — the picked model persists.
    expect(result.current.model).toMatchObject(picked);
  });
});
