/**
 * useChatTurns replay gate (T1): terminal frames of a replayed history must
 * not surface as a toast when no turn is live.
 *
 * - replay (sending:false): failTerminal / failTurn on a failed frame leave
 *   `error == null` (full-replay / cursor:null connect marker).
 * - live turn (sending:true): the same frames surface the fixed error.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { useChatChain } = await import('../useChatChain');
const { useChatTurns } = await import('../useChatTurns');

const failedFrame = (message = 'boom-replay') => ({
  data: { message, code: 'EXEC_FAILED' },
});

function renderTurns() {
  return renderHook(() => {
    const chain = useChatChain();
    const turns = useChatTurns({ chain });
    return turns;
  });
}

afterEach(() => {
  cleanup();
});

describe('useChatTurns replay gate', () => {
  test('replay without send: failTerminal + failTurn leave error==null', async () => {
    const { result } = renderTurns();
    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();

    // No send() happened — sendingRef stays false (cursor:null / full-replay
    // marker of an inactive turn from the SSE connect).
    await act(async () => {
      result.current.failTerminal(failedFrame());
    });
    expect(result.current.error).toBeNull();

    await act(async () => {
      result.current.failTurn(failedFrame('boom-replay-2'));
    });
    expect(result.current.error).toBeNull();
  });

  test('live turn: failTerminal surfaces the error, failTurn commits then surfaces', async () => {
    const { result } = renderTurns();

    // Simulate an active turn (send() sets sendingRef=true).
    await act(async () => {
      result.current.sendingRef.current = true;
      result.current.setSending(true);
    });

    await act(async () => {
      result.current.failTerminal(failedFrame('live-boom'));
    });
    expect(result.current.error).toBe('live-boom');
    expect(result.current.sending).toBe(false);

    // Second live turn via failTurn path.
    await act(async () => {
      result.current.setError(null);
      result.current.sendingRef.current = true;
      result.current.setSending(true);
    });
    await act(async () => {
      result.current.failTurn(failedFrame('live-boom-2'));
    });
    expect(result.current.error).toBe('live-boom-2');
  });
});
