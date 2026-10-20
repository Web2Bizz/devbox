'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { opencode, toErrorMessage, type OpencodeEvent } from '../api/opencode-client';
import { useI18n } from '../i18n';

export type OpencodeStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

export type UseOpencodeEventsResult = {
  events: OpencodeEvent[];
  status: OpencodeStreamStatus;
  error: string | null;
  reconnect: () => void;
};

const MAX_EVENTS = 50;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

/**
 * Live opencode event subscription through the backend reverse-proxy SSE
 * (`GET /api/opencode/global/event`, same sdk `global.event()` stream).
 *
 * - One `AbortController` per attempt; aborted on unmount (unsubscribe) and
 *   before every reconnect.
 * - Exponential backoff reconnect (1s → 15s ceiling) on clean stream end or
 *   transport failure; `reconnect()` resets the backoff and redials now.
 * - Status drives the i18n connecting/reconnecting/error badges on the page.
 */
export function useOpencodeEvents(): UseOpencodeEventsResult {
  const { t } = useI18n();
  const [events, setEvents] = useState<OpencodeEvent[]>([]);
  const [status, setStatus] = useState<OpencodeStreamStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const attemptRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Live SSE subscription — kept so unmount/reconnect can cancel the
    // upstream fetch via BOTH AbortController.signal AND stream.return()
    // (the sdk stream is an AsyncGenerator over fetch SSE; abort alone may
    // leave it hanging).
    let sub: Awaited<ReturnType<typeof opencode.global.event>> | null = null;

    const scheduleReconnect = () => {
      if (disposed) return;
      attemptRef.current += 1;
      const delay = Math.min(BASE_DELAY_MS * 2 ** (attemptRef.current - 1), MAX_DELAY_MS);
      setStatus('reconnecting');
      timer = setTimeout(() => {
        if (!disposed) void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      ctrl?.abort();
      await sub?.stream.return(undefined).catch(() => null);
      sub = null;
      ctrl = new AbortController();
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      try {
        const next = await opencode.global.event({ signal: ctrl.signal });
        if (disposed || ctrl.signal.aborted) {
          await next.stream.return(undefined).catch(() => null);
          return;
        }
        const active = next;
        sub = active;
        attemptRef.current = 0;
        setStatus('live');
        setError(null);
        try {
          for await (const ev of active.stream) {
            if (disposed || ctrl.signal.aborted) break;
            setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), ev as OpencodeEvent]);
          }
        } finally {
          // Cancel the upstream fetch when the downstream goes away
          // (unmount, reconnect, or clean upstream end before redial).
          await active.stream.return(undefined).catch(() => null);
          if (sub === active) sub = null;
        }
        // Clean upstream end → redial with backoff so the stream self-heals.
        // (Unreachable upstream answers 503 before any 200 headers are sent.)
        scheduleReconnect();
      } catch (e: unknown) {
        if (disposed || (e as Error)?.name === 'AbortError' || ctrl?.signal.aborted) return;
        const formatted = toErrorMessage(e);
        setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
        setStatus('error');
        scheduleReconnect();
      }
    };

    attemptRef.current = 0;
    void connect();

    return () => {
      disposed = true;
      ctrl?.abort();
      if (timer) clearTimeout(timer);
      // Best-effort upstream cancel — the for-await finally above also
      // calls stream.return(), this covers the connecting (pre-stream) path.
      const pending = sub;
      sub = null;
      void pending?.stream.return(undefined).catch(() => null);
    };
  }, [nonce, t]);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setNonce((n) => n + 1);
  }, []);

  return { events, status, error, reconnect };
}
