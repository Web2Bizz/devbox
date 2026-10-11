/**
 * useChat — streamed single-session chat through the opencode proxy-client.
 *
 * Covers: append (user row + assistant answer from prompt parts),
 * stop-abort (in-flight prompt cancels, server abort fires, sending clears),
 * error+retry (prompt failure surfaces, reload clears + refetches history),
 * unmount cleanup (SSE stream.return + prompt abort, no state after unmount).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

// ---- opencode proxy-client mock (same specifier shape the hook imports) ----
const sessionCreateMock = mock(async (_opts?: unknown) => ({
  data: { id: 'ses-1' },
  error: undefined,
}));
let promptImpl: (opts?: any) => Promise<any> = async (_opts?: any) => ({
  data: {
    info: { id: 'msg-assistant-1' },
    parts: [{ type: 'text', text: 'hello back' }],
  },
  error: undefined,
});
const promptMock = mock((opts?: any) => promptImpl(opts));
const sessionAbortMock = mock(async (_opts?: unknown) => ({
  data: true,
  error: undefined,
}));
const messagesImplHolder: { fn: (opts?: any) => Promise<any> } = {
  fn: async (_opts?: any) => ({ data: [], error: undefined }),
};
const messagesMock = mock((opts?: any) => messagesImplHolder.fn(opts));

let streamReturnCalls = 0;
async function* emptyStream(): AsyncGenerator<unknown, void, void> {
  // Immediately-ending SSE — the hook must redial with backoff (timer
  // cleared on unmount, so tests stay fast).
}
const eventMock = mock(async (_opts?: any) => {
  const stream = emptyStream();
  const origReturn = stream.return.bind(stream);
  (stream as any).return = async (v?: unknown) => {
    streamReturnCalls += 1;
    return origReturn(v as never);
  };
  return { stream };
});

mock.module('../../api/opencode-client', () => ({
  opencode: {
    session: {
      create: sessionCreateMock,
      prompt: promptMock,
      abort: sessionAbortMock,
      messages: messagesMock,
    },
    global: { event: eventMock },
  },
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

afterEach(() => {
  cleanup();
  sessionCreateMock.mockClear();
  promptMock.mockClear();
  sessionAbortMock.mockClear();
  messagesMock.mockClear();
  eventMock.mockClear();
  streamReturnCalls = 0;
  promptImpl = async (_opts?: any) => ({
    data: {
      info: { id: 'msg-assistant-1' },
      parts: [{ type: 'text', text: 'hello back' }],
    },
    error: undefined,
  });
  messagesImplHolder.fn = async (_opts?: any) => ({ data: [], error: undefined });
});

describe('useChat', () => {
  test('append: send() adds the user row then the assistant answer', async () => {
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send('hello');
    });

    expect(sessionCreateMock).toHaveBeenCalledTimes(1);
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'hello' });
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', text: 'hello back' });
    expect(result.current.isEmpty).toBe(false);
  });

  test('stop-abort: stop() cancels the in-flight prompt and clears sending', async () => {
    const signalBox: { current: AbortSignal | null } = { current: null };
    promptImpl = (opts?: any) =>
      new Promise((_, reject) => {
        signalBox.current = (opts?.signal as AbortSignal | undefined) ?? null;
        signalBox.current?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

    const { result, unmount } = renderHook(() => useChat());

    let sendPromise: Promise<void> | null = null;
    act(() => {
      sendPromise = result.current.send('long task');
    });
    // Let the async send() reach the pending prompt.
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.sending).toBe(true);

    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await sendPromise;
    });

    expect(signalBox.current?.aborted).toBe(true);
    expect(sessionAbortMock).toHaveBeenCalled();
    expect(result.current.sending).toBe(false);
    // User row stays, no assistant row (aborted before an answer).
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0].role).toBe('user');
    unmount();
  });

  test('error+retry: prompt failure surfaces, reload() clears and refetches', async () => {
    promptImpl = async (_opts?: any) => ({ data: undefined, error: { message: 'boom' } });
    messagesImplHolder.fn = async (_opts?: any) => ({
      data: [
        {
          info: { id: 'm1', role: 'user' },
          parts: [{ type: 'text', text: 'hi' }],
        },
      ],
      error: undefined,
    });

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send('hi');
    });
    expect(result.current.error).toBe('boom');

    act(() => {
      result.current.reload();
    });
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.error).toBeNull();
    expect(messagesMock).toHaveBeenCalled();
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', text: 'hi' });
  });

  test('unmount cleanup: SSE stream.return runs, no reconnect storm', async () => {
    const { unmount } = renderHook(() => useChat());
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(eventMock).toHaveBeenCalled();

    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(streamReturnCalls).toBeGreaterThan(0);
  });

  test('scoped: useChat({ sessionId }) loads history without create()', async () => {
    messagesImplHolder.fn = async (_opts?: any) => ({
      data: [
        {
          info: { id: 'm1', role: 'user' },
          parts: [{ type: 'text', text: 'scoped hi' }],
        },
        {
          info: { id: 'm2', role: 'assistant' },
          parts: [{ type: 'text', text: 'scoped hello back' }],
        },
      ],
      error: undefined,
    });

    const { result } = renderHook(() => useChat({ sessionId: 'ses-99' }));

    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(messagesMock).toHaveBeenCalled();
    const call = messagesMock.mock.calls[0]?.[0] as
      | { path?: { id?: string } }
      | undefined;
    expect(call?.path?.id).toBe('ses-99');
    expect(sessionCreateMock).not.toHaveBeenCalled();
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

  test('scoped: send() prompts the bound session without create()', async () => {
    messagesImplHolder.fn = async (_opts?: any) => ({
      data: [
        {
          info: { id: 'm1', role: 'user' },
          parts: [{ type: 'text', text: 'before' }],
        },
      ],
      error: undefined,
    });

    const { result } = renderHook(() =>
      useChat({ sessionId: 'ses-77', projectId: 'prj-web' }),
    );

    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sessionCreateMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.send('follow-up');
    });

    expect(sessionCreateMock).not.toHaveBeenCalled();
    expect(promptMock).toHaveBeenCalledTimes(1);
    const promptCall = promptMock.mock.calls[0]?.[0] as
      | { path?: { id?: string } }
      | undefined;
    expect(promptCall?.path?.id).toBe('ses-77');
    expect(result.current.messages.length).toBe(3);
    expect(result.current.messages[1]).toMatchObject({ role: 'user', text: 'follow-up' });
    expect(result.current.messages[2]).toMatchObject({
      role: 'assistant',
      text: 'hello back',
    });
  });
});
