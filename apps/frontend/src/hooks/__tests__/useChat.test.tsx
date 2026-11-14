/**
 * useChat — streamed single-session chat over the DOMAIN /api/v1/sessions*
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
  agentId: null,
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
const messagesImplHolder: {
  fn: (projectId: string, sessionId: string, opts?: unknown) => Promise<unknown[]>;
} = {
  fn: async () => [],
};
const messagesMock = mock((p: string, s: string, opts?: unknown) => messagesImplHolder.fn(p, s, opts));
const variantsCalls: Array<{ projectId: string; sessionId: string; opts?: unknown }> = [];
const variantsMock = mock(async (p: string, s: string, opts?: unknown) => {
  variantsCalls.push({ projectId: p, sessionId: s, opts });
  return [];
});
// Domain interrupt answer per the artifact SessionInterruptResponse.
const abortMock = mock(async (_projectId: string, _sessionId: string) => ({ interrupted: true }));
const revertHolder: { leaf: string | null } = { leaf: null };
const revertMock = mock(async (_p: string, _s: string, _m: string) => ({ activeLeaf: revertHolder.leaf }));

// A live-bus stand-in: the generator starts at mount and blocks until
// frames arrive (pushed by the test after send()), mirroring a real SSE —
// frames are consumed only while a session is bound.
const queue: unknown[] = [];
function pushFrames(frames: unknown[]): void {
  for (const f of frames) queue.push(f);
}
let seenSignals: AbortSignal[] = [];
type StreamOpts = { sessionId?: string; lastEventId?: string; onActivity?: () => void };
let seenStreamOpts: Array<StreamOpts | undefined> = [];
async function* makeStream(_projectId: string, signal: AbortSignal, _opts?: StreamOpts) {
  seenSignals.push(signal);
  seenStreamOpts.push(_opts);
  for (;;) {
    if (signal.aborted) return;
    if (queue.length > 0) {
      yield queue.shift();
      continue;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
const streamMock = mock((projectId: string, signal: AbortSignal, opts?: StreamOpts) =>
  makeStream(projectId, signal, opts),
);

mock.module('../../api/sessions-client', () => ({
  DEFAULT_AGENT_ID: 'ask',
  ensureSessionAuth: async () => {},
  createSession: (body: unknown, opts?: unknown) => createMock(body, opts),
  sendSessionMessage: (p: string, s: string, text: string, opts?: unknown) =>
    sendMock(p, s, text, opts),
  listSessionMessages: (p: string, s: string, opts?: unknown) => messagesMock(p, s, opts),
  listSessionVariants: (p: string, s: string, opts?: unknown) => variantsMock(p, s, opts),
  revertSessionMessages: (p: string, s: string, m: string) => revertMock(p, s, m),
  interruptSession: (p: string, s: string) => abortMock(p, s),
  sessionEventStream: (projectId: string, signal: AbortSignal, opts?: StreamOpts) =>
    streamMock(projectId, signal, opts),
  toErrorMessage: (e: unknown) => {
    if (e === undefined || e === null) return 'Unexpected error';
    if (typeof e === 'string') return e || 'Unexpected error';
    if (e instanceof Error) return e.message || 'Unexpected error';
    if (typeof e === 'object') {
      const obj = e as Record<string, unknown>;
      const data = obj.data as Record<string, unknown> | undefined;
      if (data && typeof data.message === 'string' && data.message) return data.message;
      if (data && typeof data.code === 'string' && data.code) return data.code;
      if (typeof obj.message === 'string' && obj.message) return obj.message;
      if (typeof obj.code === 'string' && obj.code) return obj.code;
    }
    return 'Unexpected error';
  },
}));

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { useChat } = await import('../useChat');
const { toChatEntries, toChatMessages } = await import('../../lib/chat-chain');

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

const textDelta = (session: string, text: string) => ({
  id: `evt-delta-${session}-${text}`,
  type: 'session.text.delta',
  data: { sessionID: session, delta: text },
  session,
});
const textEnded = (session: string, text: string) => ({
  id: `evt-ended-${session}`,
  type: 'session.text.ended',
  data: { sessionID: session, text },
  session,
});
const execSucceeded = (session: string) => ({
  id: `evt-exec-${session}`,
  type: 'session.execution.succeeded',
  data: { sessionID: session },
  session,
});
const textStarted = (session: string) => ({
  id: `evt-tstarted-${session}`,
  type: 'session.text.started',
  data: { sessionID: session },
  session,
});
const textDeltaNative = (session: string, text: string) => ({
  id: `evt-tdelta-${session}-${text}`,
  type: 'session.text.delta',
  data: { sessionID: session, delta: text },
  session,
});
const textEndedNative = (session: string, text: string) => ({
  id: `evt-tended-${session}`,
  type: 'session.text.ended',
  data: { sessionID: session, text },
  session,
});
const stepEnded = (session: string) => ({
  id: `evt-stepended-${session}`,
  type: 'session.step.ended',
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

// Grace finalize runs on a real 1500ms timer (no injectable clock in the
// hook), so wait just past it — the assertions are about behavior, not the
// exact boundary. Real timers keep the SSE bus polling untouched.
const GRACE_WAIT_MS = 1700;
const waitGrace = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, GRACE_WAIT_MS));
  });
};

afterEach(() => {
  cleanup();
  queue.length = 0;
  seenSignals = [];
  seenStreamOpts = [];
  createMock.mockClear();
  sendMock.mockClear();
  messagesMock.mockClear();
  variantsMock.mockClear();
  variantsCalls.length = 0;
  abortMock.mockClear();
  streamMock.mockClear();
  sendImpl = async (_p, _s, text) => ({
    id: 'msg-q1',
    type: 'user',
    createdAt: new Date(1700000001000).toISOString(),
    text,
  });
  messagesImplHolder.fn = async () => [];
  revertHolder.leaf = null;
  revertMock.mockClear();
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
    // Optimistic rows carry their own clock (ISO createdAt on the chain entries).
    const optimisticTexts = result.current.entries.filter((e) => e.kind === 'text');
    expect(optimisticTexts.length).toBe(2);
    const optimisticAt0 = Date.parse(
      (optimisticTexts[0] as { createdAt?: string }).createdAt ?? '',
    );
    const optimisticAt1 = Date.parse(
      (optimisticTexts[1] as { createdAt?: string }).createdAt ?? '',
    );
    expect(Number.isNaN(optimisticAt0)).toBe(false);
    expect(optimisticAt1).toBeGreaterThanOrEqual(optimisticAt0);
    expect(result.current.isEmpty).toBe(false);
  });

  test('append (native 2.2.0): session.text.delta + session.text.ended + execution.succeeded commit assistant row', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([
      textDelta('ses-1', 'hello'),
      textDelta('ses-1', ' back'),
      textEnded('ses-1', 'hello back'),
      execSucceeded('ses-1'),
    ]);
    await settle(16);

    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'hello back' });
  });

  test('append (live 2.2.3): session.text.delta + session.text.ended + step.ended commit assistant row', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([
      textStarted('ses-1'),
      textDeltaNative('ses-1', 'hello'),
      textDeltaNative('ses-1', ' back'),
      textEndedNative('ses-1', 'hello back'),
      stepEnded('ses-1'),
    ]);
    await settle(16);

    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'hello back' });
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
    // Flat-chronology clock lives on the chain entries (createdAt passthrough).
    const historyTexts = result.current.entries.filter((e) => e.kind === 'text');
    expect(historyTexts.map((e) => (e as { createdAt?: string }).createdAt)).toEqual([
      new Date(1700000000000).toISOString(),
      new Date(1700000001000).toISOString(),
    ]);
  });

  test('toChatMessages: text entries project without at, text:null variants skipped', () => {
    const entries = toChatEntries([
      {
        id: 'm1',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'hi',
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
        text: 'back',
      },
    ] as unknown as Parameters<typeof toChatEntries>[0]);
    expect(entries.map((e) => e.id)).toEqual(['m1', 'm3']);
    const mapped = toChatMessages(entries);
    expect(mapped).toEqual([
      { id: 'm1', role: 'user', text: 'hi' },
      { id: 'm3', role: 'assistant', text: 'back' },
    ]);
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

  test('agent: picked agent rides lazy create + prompt, survives reload', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      result.current.setAgentId('ask');
    });
    act(() => {
      void result.current.send('hi');
    });
    pushFrames([delta('ses-1', 'yo'), idle('ses-1')]);
    await settle(16);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ agentId: 'ask' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[3]).toMatchObject({ agentId: 'ask' });
    expect(result.current.agentId).toBe('ask');

    act(() => {
      result.current.reload();
    });
    await settle();
    // reload refetches history + redials SSE — the picked agent persists.
    expect(result.current.agentId).toBe('ask');
  });

const streamError = (session: string, message?: string) => ({
  id: `evt-streamerr-${session}`,
  type: 'stream.error',
  data: message === undefined ? {} : { message },
  session,
});

// Backend turn failure frames (C5): terminal like idle, but they surface
// data.message and keep the partial answer that already streamed.
const execFailed = (session: string, message?: string) => ({
  id: `evt-execfailed-${session}`,
  type: 'session.execution.failed',
  data: message === undefined ? { sessionID: session } : { sessionID: session, message },
  session,
});
const stepFailed = (session: string, message?: string) => ({
  id: `evt-stepfailed-${session}`,
  type: 'session.step.failed',
  data: message === undefined ? { sessionID: session } : { sessionID: session, message },
  session,
});

  test('agent: per-send override rides create + prompt without changing the stored agent', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hi', { agentId: 'other' });
    });
    pushFrames([delta('ses-1', 'yo'), idle('ses-1')]);
    await settle(16);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ agentId: 'other' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[3]).toMatchObject({ agentId: 'other' });
    // The stored picker value is untouched by the one-off override.
    expect(result.current.agentId).toBe('ask');
  });

  test('terminal stream.error surfaces the error, preserves the thread, clears sending', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([delta('ses-1', 'partial'), streamError('ses-1', 'runner blew up')]);
    await settle(16);

    expect(result.current.error).toBe('runner blew up');
    expect(result.current.sending).toBe(false);
    // The thread is preserved: user row stays, no phantom assistant commit.
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'hello' });
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(1);
  });

  test('terminal stream.error without a message falls back to the unexpected-error copy', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([streamError('ses-1')]);
    await settle(16);

    expect(typeof result.current.error).toBe('string');
    expect((result.current.error ?? '').length).toBeGreaterThan(0);
    expect(result.current.sending).toBe(false);
    expect(result.current.messages.length).toBe(1);
  });

  test('execution.failed is terminal: partial answer committed, fixed error surfaces', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([delta('ses-1', 'partial answer'), execFailed('ses-1', 'ход не выполнен')]);
    await settle(16);

    expect(result.current.error).toBe('ход не выполнен');
    expect(result.current.sending).toBe(false);
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(2);
    expect(result.current.activeToolName).toBeNull();
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'partial answer',
    });
  });

  test('step.failed without partial text leaves the thread, still clears sending', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([stepFailed('ses-1')]);
    await settle(16);

    expect(typeof result.current.error).toBe('string');
    expect(result.current.sending).toBe(false);
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'hello' });
  });

  test('failed frame is idempotent with a later idle (no duplicate commit)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([delta('ses-1', 'once'), execFailed('ses-1', 'boom'), idle('ses-1')]);
    await settle(16);

    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'once' });
    expect(result.current.error).toBe('boom');
    expect(result.current.sending).toBe(false);
  });

  test('execution.failed with code-only data falls back to unexpected (failTerminal is message-only)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([
      delta('ses-1', 'partial answer'),
      {
        id: 'evt-execfailed-code-ses-1',
        type: 'session.execution.failed',
        data: { sessionID: 'ses-1', code: 'max-steps-exceeded' },
        session: 'ses-1',
      },
    ]);
    await settle(16);

    // src failTerminal reads only data.message, so code-only → t.errors.unexpected.
    // The mocked toErrorMessage above stays code-first (mirrors sessions-client),
    // but the failed-frame path does not route through it.
    expect(result.current.error).toBe('Unexpected error');
    expect(result.current.sending).toBe(false);
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'partial answer',
    });
  });

  test('stream.error of a foreign session never touches this chat', async () => {
    const { result } = renderHook(() => useChat({ sessionId: 'ses-1', ...PROJECT }));
    await settle();

    await act(async () => {
      await result.current.send('go');
    });
    pushFrames([streamError('ses-other', 'not mine')]);
    await settle(16);

    expect(result.current.error).toBeNull();
    expect(result.current.sending).toBe(true);
  });

  test('stop epoch: late frames of the aborted turn are dropped (no resurrection)', async () => {
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
    expect(result.current.messages.length).toBe(2);

    // The interrupted turn keeps streaming server-side — its late frames
    // must not commit a second assistant row or flip sending back on.
    pushFrames([delta('ses-1', 'LATE'), idle('ses-1')]);
    await settle(16);

    expect(result.current.sending).toBe(false);
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'half an answer',
    });
    expect(result.current.error).toBeNull();
  });

  test('session scope: foreign deltas never stream, foreign idle never finalizes', async () => {
    const { result } = renderHook(() => useChat({ sessionId: 'ses-1', ...PROJECT }));
    await settle();

    await act(async () => {
      await result.current.send('go');
    });
    pushFrames([delta('ses-other', 'NOT ME'), idle('ses-other')]);
    await settle(16);

    // Still sending: the foreign terminator is not our commit signal.
    expect(result.current.sending).toBe(true);
    expect(result.current.messages.length).toBe(1);
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(1);

    pushFrames([delta('ses-1', 'mine'), idle('ses-1')]);
    await settle(16);

    expect(result.current.sending).toBe(false);
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'mine' });
  });

  test('subscription opts: scoped mount passes sessionId + onActivity to the stream', async () => {
    renderHook(() => useChat({ sessionId: 'ses-99', ...PROJECT }));
    await settle();

    expect(streamMock).toHaveBeenCalled();
    const opts = seenStreamOpts.at(-1);
    expect(opts?.sessionId).toBe('ses-99');
    expect(typeof opts?.onActivity).toBe('function');
  });

  test('subscription opts: lazy mount starts unscoped (no sessionId yet)', async () => {
    renderHook(() => useChat({ ...PROJECT }));
    await settle();

    expect(streamMock).toHaveBeenCalled();
    expect(seenStreamOpts.at(-1)?.sessionId).toBeUndefined();
    expect(typeof seenStreamOpts.at(-1)?.onActivity).toBe('function');
  });

  test('resync: window online refreshes history quietly (no error)', async () => {
    messagesImplHolder.fn = async () => [
      {
        id: 'm1',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'before',
      },
    ];
    const { result } = renderHook(() => useChat({ sessionId: 'ses-77', ...PROJECT }));
    await settle();
    expect(result.current.messages.length).toBe(1);

    messagesImplHolder.fn = async () => [
      {
        id: 'm1',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'before',
      },
      {
        id: 'm2',
        type: 'assistant',
        createdAt: new Date(1700000001000).toISOString(),
        text: 'after reconnect',
      },
    ];
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    expect(messagesMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'after reconnect',
    });
    expect(result.current.error).toBeNull();
  });

  test('resync: becoming visible refreshes history quietly (no error)', async () => {
    messagesImplHolder.fn = async () => [];
    renderHook(() => useChat({ sessionId: 'ses-77', ...PROJECT }));
    await settle();
    const callsBefore = messagesMock.mock.calls.length;

    messagesImplHolder.fn = async () => [
      {
        id: 'm9',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'visible hi',
      },
    ];
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();

    expect(messagesMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('resync failure keeps the local thread (transient, never setError)', async () => {
    messagesImplHolder.fn = async () => [
      {
        id: 'm1',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'local only',
      },
    ];
    const { result } = renderHook(() => useChat({ sessionId: 'ses-77', ...PROJECT }));
    await settle();
    expect(result.current.messages.length).toBe(1);

    messagesImplHolder.fn = async () => {
      throw new Error('history down');
    };
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'local only' });
    expect(result.current.error).toBeNull();
  });

  // ---- F2 host tool lifecycle (session.tool.* additive, never streaming) --
  const toolCalled = (session: string, tool: string, extra: Record<string, unknown> = {}) => ({
    id: `evt-tool-called-${session}-${tool}-${Math.random()}`,
    type: 'session.tool.called',
    data: { sessionID: session, tool, ...extra },
    session,
  });
  const toolProgress = (session: string, tool: string, message = 'working') => ({
    id: `evt-tool-progress-${session}-${tool}-${message}-${Math.random()}`,
    type: 'session.tool.progress',
    data: { sessionID: session, tool, message },
    session,
  });
  const toolSuccess = (session: string, tool: string) => ({
    id: `evt-tool-success-${session}-${tool}-${Math.random()}`,
    type: 'session.tool.success',
    data: { sessionID: session, tool },
    session,
  });
  const toolFailed = (session: string, tool: string, error = 'boom') => ({
    id: `evt-tool-failed-${session}-${tool}-${Math.random()}`,
    type: 'session.tool.failed',
    data: { sessionID: session, tool, error },
    session,
  });
  const toolInputStarted = (session: string, tool: string) => ({
    id: `evt-tool-input-${session}-${tool}-${Math.random()}`,
    type: 'session.tool.input.started',
    data: { sessionID: session, tool },
    session,
  });
  const reasoningFrame = (session: string, suffix: string) => ({
    id: `evt-reasoning-${session}-${suffix}`,
    type: 'session.reasoning.delta',
    data: { sessionID: session, delta: 'THINKING-NOT-CHAT' },
    session,
  });
  const legacyToolPart = (session: string, tool: string, partId = 'prt-tool-1') => ({
    id: `evt-legacy-tool-${session}-${tool}`,
    type: 'message.part.updated',
    data: { sessionID: session, part: { id: partId, type: 'tool', tool } },
    session,
  });

  test('tool.called → activeToolName + additive chain tool, messages stay clean', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('do stuff');
    });
    pushFrames([toolCalled('ses-1', 'bash')]);
    await settle(16);

    expect(result.current.activeToolName).toBe('bash');
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(1);
    const tools = result.current.entries.filter((e) => e.kind === 'tool');
    expect(tools.length).toBe(1);
    expect(tools[0]).toMatchObject({ kind: 'tool', name: 'bash' });
    // Unified chain: the same live tool lands as a `tool` entry (leaf follows
    // the tool so `buildThreadRows(...).chain` keeps it for rendering).
    const chainTools = result.current.entries.filter((e) => e.kind === 'tool');
    expect(chainTools.length).toBe(1);
    expect(chainTools[0]).toMatchObject({ kind: 'tool', name: 'bash', status: 'called' });
    expect(result.current.leafId).toBe(chainTools[0]?.id);
    // Tool payload never becomes a chat row while the turn is live.
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]).toMatchObject({ role: 'user' });

    pushFrames([idle('ses-1')]);
    await settle(16);
    expect(result.current.sending).toBe(false);
  });

  test('tool progress throttled: many progress frames log once per turn', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('run tools');
    });
    pushFrames([
      toolCalled('ses-1', 'bash'),
      toolProgress('ses-1', 'bash', 'step one'),
      toolProgress('ses-1', 'bash', 'step two'),
      toolProgress('ses-1', 'bash', 'step three'),
    ]);
    await settle(16);

    const tools = result.current.entries.filter((e) => e.kind === 'tool');
    expect(tools.length).toBe(2);
    expect(tools[0]).toMatchObject({ name: 'bash' });
    // Only the first progress payload is kept (later frames throttled).
    expect(tools[1]).toMatchObject({ name: 'bash', detail: 'step one' });
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(1);
    // Unified chain mirrors the throttled trace: called + first progress land
    // as `tool` entries, later progress bursts dedup.
    const chainTools = result.current.entries.filter((e) => e.kind === 'tool');
    expect(chainTools.length).toBe(2);
    expect(chainTools[0]).toMatchObject({ name: 'bash', status: 'called' });
    expect(chainTools[1]).toMatchObject({ name: 'bash', status: 'progress' });

    pushFrames([idle('ses-1')]);
    await settle(16);
  });

  test('tool success/failed logged once per tool (duplicates ignored)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('two tools');
    });
    pushFrames([
      toolCalled('ses-1', 'bash'),
      toolSuccess('ses-1', 'bash'),
      toolSuccess('ses-1', 'bash'),
      toolCalled('ses-1', 'edit'),
      toolFailed('ses-1', 'edit'),
      toolFailed('ses-1', 'edit'),
    ]);
    await settle(16);

    const tools = result.current.entries.filter((e) => e.kind === 'tool');
    const doneBash = tools.filter((e) => e.kind === 'tool' && e.name === 'bash' && e.status === 'done');
    const failedEdit = tools.filter((e) => e.kind === 'tool' && e.name === 'edit' && e.status === 'failed');
    expect(doneBash.length).toBe(1);
    expect(failedEdit.length).toBe(1);
    // called-once-per-tool still holds alongside done-once-per-tool.
    expect(tools.filter((e) => e.kind === 'tool' && e.name === 'bash').length).toBe(2);
    expect(tools.filter((e) => e.kind === 'tool' && e.name === 'edit').length).toBe(2);
    expect(result.current.activeToolName).toBe('edit');
    // Unified chain: called → done/failed each land once per tool (burst
    // duplicates ignored, second invocation after done still lands).
    const chainTools = result.current.entries.filter((e) => e.kind === 'tool');
    expect(chainTools.filter((e) => e.kind === 'tool' && e.name === 'bash' && e.status === 'done').length).toBe(1);
    expect(chainTools.filter((e) => e.kind === 'tool' && e.name === 'edit' && e.status === 'failed').length).toBe(1);

    pushFrames([idle('ses-1')]);
    await settle(16);
  });

  test('tool input.started counts as called when the runner skips called', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('input only');
    });
    pushFrames([toolInputStarted('ses-1', 'grep'), toolInputStarted('ses-1', 'grep')]);
    await settle(16);

    const tools = result.current.entries.filter((e) => e.kind === 'tool');
    expect(tools.length).toBe(1);
    expect(tools[0]).toMatchObject({ name: 'grep' });
    expect(result.current.activeToolName).toBe('grep');
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(1);

    pushFrames([idle('ses-1')]);
    await settle(16);
  });

  test('legacy message.part.updated tool part: no regression on text snapshots', async () => {
    const { result } = renderHook(() => useChat({ sessionId: 'ses-1', ...PROJECT }));
    await settle();

    await act(async () => {
      await result.current.send('go');
    });
    pushFrames([
      legacyToolPart('ses-1', 'bash'),
      updated('ses-1', 'part one', 'prt-9'),
      updated('ses-1', 'part one two', 'prt-9'),
      idle('ses-1'),
    ]);
    await settle(16);

    // Legacy non-text part still surfaces as live tool status + chain entry.
    const tools = result.current.entries.filter((e) => e.kind === 'tool');
    expect(tools.length).toBe(1);
    expect(tools[0]).toMatchObject({ name: 'bash' });
    // Text snapshots keep the growth-only behavior (no duplication).
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'part one two',
    });
  });

  test('legacy text part.updated never becomes a tool trace', async () => {
    const { result } = renderHook(() => useChat({ sessionId: 'ses-1', ...PROJECT }));
    await settle();

    await act(async () => {
      await result.current.send('go');
    });
    pushFrames([updated('ses-1', 'just text', 'prt-1'), idle('ses-1')]);
    await settle(16);

    expect(result.current.entries.filter((e) => e.kind === 'tool').length).toBe(0);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'just text' });
  });

  test('reasoning frames surface as live reasoning steps', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('think');
    });
    pushFrames([reasoningFrame('ses-1', 'a'), reasoningFrame('ses-1', 'b')]);
    await settle(16);

    expect(result.current.activeToolName).toBeNull();
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(1);
    const reasoningTools = result.current.entries.filter((e) => e.kind === 'tool' && e.name === 'reasoning');
    expect(reasoningTools.length).toBe(1);
    expect(reasoningTools[0]).toMatchObject({ name: 'reasoning' });
    expect(result.current.entries.filter((e) => e.kind === 'tool' && e.name !== 'reasoning').length).toBe(0);
    expect(result.current.messages.length).toBe(1);
    expect(result.current.sending).toBe(true);

    pushFrames([idle('ses-1')]);
    await settle(16);
  });

  test('tool frames never land in messages (payload isolation)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([
      toolCalled('ses-1', 'bash', { message: 'SHOULD-NOT-RENDER' }),
      textDelta('ses-1', 'hello'),
      toolProgress('ses-1', 'bash', 'SHOULD-NOT-RENDER-PROGRESS'),
      textDelta('ses-1', ' world'),
      toolSuccess('ses-1', 'bash'),
      textEnded('ses-1', 'hello world'),
      execSucceeded('ses-1'),
    ]);
    await settle(16);

    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'hello world' });
    expect(result.current.messages[1]?.text).not.toContain('SHOULD-NOT-RENDER');
    expect(result.current.messages[1]?.text).not.toContain('bash');
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(2);
    expect(result.current.entries.filter((e) => e.kind === 'tool').length).toBeGreaterThan(0);
  });

  test('hostile tool frames without a name are dropped (no status, no chain row, no crash)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hostile');
    });
    pushFrames([
      {
        id: 'evt-hostile-1',
        type: 'session.tool.called',
        data: { sessionID: 'ses-1' },
        session: 'ses-1',
      },
      {
        id: 'evt-hostile-2',
        type: 'session.tool.progress',
        data: { sessionID: 'ses-1', tool: '' },
        session: 'ses-1',
      },
      {
        id: 'evt-hostile-3',
        type: 'session.tool.called',
        data: { sessionID: 'ses-1', tool: 42 },
        session: 'ses-1',
      },
    ]);
    await settle(16);

    expect(result.current.activeToolName).toBeNull();
    expect(result.current.entries.filter((e) => e.kind === 'tool').length).toBe(0);
    expect(result.current.error).toBeNull();

    pushFrames([idle('ses-1')]);
    await settle(16);
  });

  test('chain owns user-visible tool rows (entries single source)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    pushFrames([toolCalled('ses-1', 'bash')]);
    await settle(16);

    // Chain is the single source: user-visible tool rows live in entries
    // (durable text + live tool sidecar share one type).
    const kinds = result.current.entries.map((e) => e.kind);
    expect(kinds).toContain('tool');

    pushFrames([idle('ses-1')]);
    await settle(16);
  });

  // ---- grace finalize safety net (complete text block, lost terminator) ---
  // Live sidecar accumulates the full block; finalize owns
  // idle/succeeded/step.ended/failed. A lost terminator therefore leaves
  // the turn open (stuck-sending watchdog covers it via REST, 90s — out
  // of scope for this unit test).
  // terminator therefore leaves the turn open (stuck-sending watchdog covers
  // it via REST, 90s — out of scope for this unit test).
  test('grace: text.ended without a terminator leaves the turn open (no auto-commit)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    // The lazy SSE stream stays unscoped (no redial on create — effect deps
    // are [nonce, projectId]); frames are filtered by sessionIdRef, so no
    // extra settle for a redial is needed.
    await settle(16);
    pushFrames([textDelta('ses-1', 'hello'), textEnded('ses-1', 'hello')]);
    await settle(16);

    // text.ended carries a complete block but is NOT a terminator: the turn
    // is still open (tools/next steps may follow).
    expect(result.current.sending).toBe(true);
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(1);

    await waitGrace();

    // No grace-finalize in src: still open, no assistant commit yet.
    expect(result.current.sending).toBe(true);
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'hello' });
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(1);
  });

  test('grace: a real terminator before the window commits once (no duplicate)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('hello');
    });
    // Let the lazy create + SSE redial (Fix 3) settle before frames arrive.
    await settle(16);
    pushFrames([textDelta('ses-1', 'hello'), textEnded('ses-1', 'hello'), execSucceeded('ses-1')]);
    await settle(16);

    expect(result.current.sending).toBe(false);
    expect(result.current.messages.length).toBe(2);

    await waitGrace();

    // The terminator cancelled the grace timer — no second assistant row.
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'hello' });
  });

  test('grace: stop() cancels the pending grace (no second commit)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('long task');
    });
    // Let the lazy create + SSE redial (Fix 3) settle before frames arrive.
    await settle(16);
    pushFrames([textDelta('ses-1', 'half'), textEnded('ses-1', 'half')]);
    await settle(16);

    act(() => {
      result.current.stop();
    });
    await settle();
    expect(result.current.messages.length).toBe(2);

    await waitGrace();

    expect(result.current.sending).toBe(false);
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'half' });
  });

  test('grace: a foreign session frame never arms or commits this chat', async () => {
    const { result } = renderHook(() => useChat({ sessionId: 'ses-1', ...PROJECT }));
    await settle();

    await act(async () => {
      await result.current.send('go');
    });
    pushFrames([textEnded('ses-other', 'NOT MINE')]);
    await settle(16);
    expect(result.current.entries.filter((e) => e.kind === 'text').length).toBe(1);

    await waitGrace();

    // No grace was armed for a foreign frame: the turn stays open.
    expect(result.current.sending).toBe(true);
    expect(result.current.messages.length).toBe(1);
  });

  // ---- lazy SSE scope (session created after mount) ----------------------
  // src SSE effect deps are [nonce, projectId]: ensureSession sets
  // sessionIdRef but never bumps nonce, so no redial happens. The single
  // unscoped stream keeps serving; frames are filtered by sessionIdRef.
  test('lazy SSE: creating the session keeps the unscoped stream (no redial)', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();
    // Mount-time subscription: no session yet, so no ?session=.
    expect(seenStreamOpts.at(-1)?.sessionId).toBeUndefined();

    await act(async () => {
      void result.current.send('hello');
    });
    await settle(16);

    expect(createMock).toHaveBeenCalledTimes(1);
    // No redial on lazy create — the wire stays unscoped; sessionIdRef owns scope.
    expect(seenStreamOpts.at(-1)?.sessionId).toBeUndefined();
  });

  test('branch switcher: selectLeaf moves the active leaf locally (chain oracle, no refetch)', async () => {
    messagesImplHolder.fn = async () => [
      {
        id: 'root',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'root',
        parentId: null,
      },
      {
        id: 'b',
        type: 'assistant',
        createdAt: new Date(1700000001000).toISOString(),
        text: 'first',
        parentId: 'root',
      },
      {
        id: 'd',
        type: 'assistant',
        createdAt: new Date(1700000002000).toISOString(),
        text: 'deep',
        parentId: 'b',
      },
    ];
    const { result } = renderHook(() => useChat({ sessionId: 'ses-99', ...PROJECT }));
    await settle();
    expect(result.current.messages.map((row) => row.id)).toEqual(['root', 'b', 'd']);

    variantsCalls.length = 0;
    variantsMock.mockClear();
    messagesMock.mockClear();
    await act(async () => {
      result.current.selectLeaf('b');
    });
    await settle();

    // Pure chain oracle: leaf b → chain root→b, no REST refetch, no variants fetch.
    expect(result.current.leafId).toBe('b');
    expect(result.current.activeLeaf?.id).toBe('b');
    expect(result.current.messages.map((row) => row.id)).toEqual(['root', 'b']);
    expect(messagesMock).not.toHaveBeenCalled();
    expect(variantsMock).not.toHaveBeenCalled();
  });

  test('branch tip: send() after selectLeaf parents the prompt at the active leaf', async () => {
    messagesImplHolder.fn = async () => [
      {
        id: 'root',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'root',
        parentId: null,
      },
      {
        id: 'b',
        type: 'assistant',
        createdAt: new Date(1700000001000).toISOString(),
        text: 'first',
        parentId: 'root',
      },
      {
        id: 'd',
        type: 'assistant',
        createdAt: new Date(1700000002000).toISOString(),
        text: 'deep',
        parentId: 'b',
      },
    ];
    const { result } = renderHook(() => useChat({ sessionId: 'ses-99', ...PROJECT }));
    await settle();

    await act(async () => {
      result.current.selectLeaf('d');
    });
    await settle();
    expect(result.current.leafId).toBe('d');
    expect(result.current.activeLeaf?.id).toBe('d');

    sendMock.mockClear();
    await act(async () => {
      void result.current.send('follow-up');
    });
    await settle();

    // Prompt parents locally at the branch tip (user entry parentId:'d');
    // the POST itself carries only (projectId, sid, text, {signal, agentId}) —
    // src does not forward parentId, the server resolves the tail.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls.at(-1)?.[0]).toBe(PROJECT.projectId);
    expect(sendMock.mock.calls.at(-1)?.[1]).toBe('ses-99');
    expect(sendMock.mock.calls.at(-1)?.[2]).toBe('follow-up');
    expect(sendMock.mock.calls.at(-1)?.[3]).toMatchObject({ agentId: 'ask' });
    expect((sendMock.mock.calls.at(-1)?.[3] as Record<string, unknown>)?.parentId).toBeUndefined();
  });

  test('branch scope: resync refreshes history quietly, leaf follows the durable tip', async () => {
    messagesImplHolder.fn = async () => [
      {
        id: 'root',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'root',
        parentId: null,
      },
      {
        id: 'b',
        type: 'assistant',
        createdAt: new Date(1700000001000).toISOString(),
        text: 'first',
        parentId: 'root',
      },
      {
        id: 'd',
        type: 'assistant',
        createdAt: new Date(1700000002000).toISOString(),
        text: 'deep',
        parentId: 'b',
      },
    ];
    const { result } = renderHook(() => useChat({ sessionId: 'ses-99', ...PROJECT }));
    await settle();
    await act(async () => {
      result.current.selectLeaf('d');
    });
    await settle();

    variantsCalls.length = 0;
    variantsMock.mockClear();
    messagesMock.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    expect(messagesMock).toHaveBeenCalled();
    expect(messagesMock.mock.calls.at(-1)?.[1]).toBe('ses-99');
    expect(result.current.leafId).toBe('d');
    expect(result.current.messages.map((row) => row.id)).toEqual(['root', 'b', 'd']);
    expect(variantsMock).not.toHaveBeenCalled();
  });

  test('branch scope: stale leaf falls back to full on 404 (resync never blanks)', async () => {
    messagesImplHolder.fn = async () => [
      {
        id: 'root',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'root',
        parentId: null,
      },
    ];
    const { result } = renderHook(() => useChat({ sessionId: 'ses-99', ...PROJECT }));
    await settle();
    await act(async () => {
      result.current.selectLeaf('ghost');
    });
    await settle();
    // Unknown leaf keeps the full thread locally (frontend fallback) while the
    // backend would 404 the same leaf — the thread never blanks.
    expect(result.current.messages.map((row) => row.id)).toEqual(['root']);
  });

  test('branch scope: reload refetches history, leaf follows the durable tip', async () => {
    messagesImplHolder.fn = async () => [
      {
        id: 'root',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'root',
        parentId: null,
      },
      {
        id: 'b',
        type: 'assistant',
        createdAt: new Date(1700000001000).toISOString(),
        text: 'first',
        parentId: 'root',
      },
    ];
    const { result } = renderHook(() => useChat({ sessionId: 'ses-99', ...PROJECT }));
    await settle();
    await act(async () => {
      result.current.selectLeaf('b');
    });
    await settle();

    variantsMock.mockClear();
    messagesMock.mockClear();
    await act(async () => {
      result.current.reload();
    });
    await settle();

    expect(messagesMock).toHaveBeenCalled();
    expect(messagesMock.mock.calls.at(-1)?.[1]).toBe('ses-99');
    expect(result.current.leafId).toBe('b');
    expect(result.current.messages.map((row) => row.id)).toEqual(['root', 'b']);
    expect(variantsMock).not.toHaveBeenCalled();
  });

  test('branch scope: revertTo moves the leaf to the target parent (Forward-Only, no delete)', async () => {
    messagesImplHolder.fn = async () => [
      {
        id: 'root',
        type: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        text: 'root',
        parentId: null,
      },
      {
        id: 'b',
        type: 'assistant',
        createdAt: new Date(1700000001000).toISOString(),
        text: 'kept',
        parentId: 'root',
      },
      {
        id: 'd',
        type: 'assistant',
        createdAt: new Date(1700000002000).toISOString(),
        text: 'tail',
        parentId: 'b',
      },
    ];
    const { result } = renderHook(() => useChat({ sessionId: 'ses-99', ...PROJECT }));
    await settle();
    expect(result.current.messages.map((row) => row.id)).toEqual(['root', 'b', 'd']);

    variantsMock.mockClear();
    messagesMock.mockClear();
    revertMock.mockClear();
    await act(async () => {
      result.current.revertTo('d');
    });
    await settle();

    expect(revertMock).not.toHaveBeenCalled();
    expect(messagesMock).not.toHaveBeenCalled();
    expect(result.current.messages.map((row) => row.id)).toEqual(['root', 'b']);
    expect(result.current.leafId).toBe('b');
    expect(result.current.activeLeaf?.id).toBe('b');
    expect(variantsMock).not.toHaveBeenCalled();
  });
});
