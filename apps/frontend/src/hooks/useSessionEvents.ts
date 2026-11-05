'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionStreamFrame } from '@rush-code/contracts';
import { sessionEventStream, toErrorMessage } from '../api/sessions-client';
import { useI18n } from '../i18n';

export type SessionStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

export type UseSessionEventsResult = {
  events: SessionStreamFrame[];
  status: SessionStreamStatus;
  error: string | null;
  reconnect: () => void;
};

const MAX_EVENTS = 50;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

/**
 * Live session events through the domain SSE route
 * (`GET /api/v1/sessions/events?projectId=…`, api/sessions-client).
 *
 * Deliberately `useEffect`, NOT React Query: a long-lived streaming
 * subscription with self-healing reconnects is the AGENTS.md streaming
 * exception (same rationale as useChat).
 *
 * Frames are domain `SessionStreamFrame` rows ({id, type, data, session?})
 * — every payload goes through the boundary schema (a malformed frame
 * throws out of the generator → error state + backoff redial, never a
 * silent cast). `projectId` is the C4 gate: without it no stream is
 * dialled and the honest PROJECT_REQUIRED error is surfaced (never a
 * global anonymous subscription).
 *
 * - One `AbortController` per attempt; aborted on unmount (unsubscribe)
 *   and before every reconnect — the signal reaches the fetch body, so
 *   going away really closes the upstream stream.
 * - Exponential backoff reconnect (1s → 15s ceiling) on clean stream end
 *   or transport failure; `reconnect()` resets the backoff and redials now.
 * - Status drives the i18n connecting/reconnecting/error badges.
 */
export function useSessionEvents(projectId?: string): UseSessionEventsResult {
  const { t } = useI18n();
  const [events, setEvents] = useState<SessionStreamFrame[]>([]);
  const [status, setStatus] = useState<SessionStreamStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!projectId) {
      // Defensive path (every caller scopes by project): the domain route
      // answers the same fixed PROJECT_REQUIRED — surfaced honestly, never
      // an anonymous global stream.
      setStatus('error');
      setError('projectId is required — events are project-scoped');
      return;
    }
    let disposed = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Live SSE iterator — kept so unmount/reconnect can cancel the fetch
    // stream via the AbortController signal (and the generator's finally
    // releases the body reader).

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
      ctrl = new AbortController();
      const active = ctrl;
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      try {
        for await (const frame of sessionEventStream(projectId, active.signal)) {
          if (disposed || active.signal.aborted) break;
          setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), frame]);
        }
        if (disposed || active.signal.aborted) return;
        // Clean upstream end → redial with backoff so the stream self-heals.
        // (Unreachable runner answers 503 before any 200 headers are sent.)
        scheduleReconnect();
      } catch (e: unknown) {
        if (disposed || (e as Error)?.name === 'AbortError' || active.signal.aborted) return;
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
    };
  }, [nonce, projectId, t]);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setNonce((n) => n + 1);
  }, []);

  return { events, status, error, reconnect };
}
