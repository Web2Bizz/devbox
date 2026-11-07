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
  ensureSessionAuth: async () => {},
  createSession: (body: unknown, opts?: unknown) => createMock(body, opts),
  sendSessionMessage: (p: string, s: string, text: string, opts?: unknown) =>
    sendMock(p, s, text, opts),
  listSessionMessages: (p: string, s: string) => messagesMock(p, s),
  interruptSession: (p: string, s: string) => abortMock(p, s),
  sessionEventStream: (projectId: string, signal: AbortSignal, opts?: StreamOpts) =>
    streamMock(projectId, signal, opts),
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

afterEach(() => {
  cleanup();
  queue.length = 0;
  seenSignals = [];
  seenStreamOpts = [];
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
    expect(result.current.streamingText).toBe('');
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
    expect(result.current.streamingText).toBe('');

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

  test('tool.called → activeToolName + additive tool trace, streamingText stays empty', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('do stuff');
    });
    pushFrames([toolCalled('ses-1', 'bash')]);
    await settle(16);

    expect(result.current.activeToolName).toBe('bash');
    expect(result.current.streamingText).toBe('');
    const tools = result.current.toolTrace.filter((e) => e.kind === 'tool');
    expect(tools.length).toBe(1);
    expect(tools[0]).toMatchObject({ kind: 'tool', label: 'bash' });
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

    const tools = result.current.toolTrace.filter((e) => e.kind === 'tool');
    expect(tools.length).toBe(2);
    expect(tools[0]).toMatchObject({ label: 'bash' });
    // Only the first progress payload is kept (later frames throttled).
    expect(tools[1]).toMatchObject({ label: 'bash', detail: 'step one' });
    expect(result.current.streamingText).toBe('');

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

    const tools = result.current.toolTrace.filter((e) => e.kind === 'tool');
    const doneBash = tools.filter((e) => e.label === 'bash' && e.detail === 'done');
    const failedEdit = tools.filter((e) => e.label === 'edit' && e.detail === 'boom');
    expect(doneBash.length).toBe(1);
    expect(failedEdit.length).toBe(1);
    // called-once-per-tool still holds alongside done-once-per-tool.
    expect(tools.filter((e) => e.label === 'bash').length).toBe(2);
    expect(tools.filter((e) => e.label === 'edit').length).toBe(2);
    expect(result.current.activeToolName).toBe('edit');

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

    const tools = result.current.toolTrace.filter((e) => e.kind === 'tool');
    expect(tools.length).toBe(1);
    expect(tools[0]).toMatchObject({ label: 'grep' });
    expect(result.current.activeToolName).toBe('grep');
    expect(result.current.streamingText).toBe('');

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

    // Legacy non-text part still surfaces as live tool status + trace.
    const tools = result.current.toolTrace.filter((e) => e.kind === 'tool');
    expect(tools.length).toBe(1);
    expect(tools[0]).toMatchObject({ label: 'bash' });
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

    expect(result.current.toolTrace.filter((e) => e.kind === 'tool').length).toBe(0);
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'just text' });
  });

  test('reasoning frames surface nowhere: no tool, no text, no trace', async () => {
    const { result } = renderHook(() => useChat({ ...PROJECT }));
    await settle();

    act(() => {
      void result.current.send('think');
    });
    pushFrames([reasoningFrame('ses-1', 'a'), reasoningFrame('ses-1', 'b')]);
    await settle(16);

    expect(result.current.activeToolName).toBeNull();
    expect(result.current.streamingText).toBe('');
    expect(result.current.toolTrace.filter((e) => e.kind === 'tool').length).toBe(0);
    expect(result.current.messages.length).toBe(1);
    expect(result.current.sending).toBe(true);

    pushFrames([idle('ses-1')]);
    await settle(16);
  });

  test('tool frames never land in messages/streaming (payload isolation)', async () => {
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
    expect(result.current.streamingText).toBe('');
    expect(result.current.toolTrace.filter((e) => e.kind === 'tool').length).toBeGreaterThan(0);
  });

  test('hostile tool frames without a name are dropped (no status, no trace, no crash)', async () => {
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
    expect(result.current.streamingText).toBe('');
    expect(result.current.toolTrace.filter((e) => e.kind === 'tool').length).toBe(0);
    expect(result.current.error).toBeNull();

    pushFrames([idle('ses-1')]);
    await settle(16);
  });
});
