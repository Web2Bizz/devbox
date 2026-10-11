'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { opencode, toErrorMessage } from '../api/opencode-client';
import type { OpencodeEvent } from '../api/opencode-client';
import { useI18n } from '../i18n';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface UseChatOptions {
  /** Existing opencode session to scope the chat to (session = chat). */
  sessionId?: string;
  /** Opencode working directory, forwarded as `?directory=`. */
  directory?: string;
  /** DevBox project id (prj-*) — UI-only until backend maps project → directory. */
  projectId?: string;
}

export interface UseChatResult {
  messages: ChatMessage[];
  streamingText: string;
  loading: boolean;
  sending: boolean;
  error: string | null;
  isEmpty: boolean;
  /** Active session id (initial option or lazily created). */
  sessionId: string | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  reload: () => void;
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/** Session id carried by an SSE payload, when the event is session-scoped. */
function eventSessionId(ev: OpencodeEvent): string | null {
  const payload = (ev as { payload?: unknown }).payload as
    | { type?: string; properties?: Record<string, unknown> }
    | undefined;
  if (!payload || typeof payload !== 'object') return null;
  const props = payload.properties;
  if (!props || typeof props !== 'object') return null;
  if (typeof props.sessionID === 'string') return props.sessionID;
  const part = props.part as { sessionID?: unknown } | undefined;
  if (part && typeof part.sessionID === 'string') return part.sessionID;
  const info = props.info as { sessionID?: unknown } | undefined;
  if (info && typeof info.sessionID === 'string') return info.sessionID;
  return null;
}

/** Text delta carried by `message.part.updated` (absolute text fallback). */
function eventDelta(ev: OpencodeEvent): string | null {
  const payload = (ev as { payload?: unknown }).payload as
    | { type?: string; properties?: Record<string, unknown> }
    | undefined;
  if (payload?.type !== 'message.part.updated') return null;
  const props = payload.properties as
    | { delta?: unknown; part?: { type?: unknown; text?: unknown } }
    | undefined;
  if (!props) return null;
  if (typeof props.delta === 'string' && props.delta) return props.delta;
  // Some servers send the full part text without a delta — the caller
  // appends only when it grows (handled by length check in the subscriber).
  if (props.part?.type === 'text' && typeof props.part.text === 'string') {
    return props.part.text;
  }
  return null;
}

function formatError(e: unknown, fallback: string): string {
  const formatted = toErrorMessage(e);
  return formatted === 'Unexpected error' ? fallback : formatted;
}

/**
 * Chat over the backend reverse-proxy (`<NEXT_PUBLIC_API_URL>/api/opencode`,
 * same @opencode-ai/sdk 1.18.33 as the backend).
 *
 * Two modes (session = chat):
 * - Unscoped (legacy): `useChat()` or `useChat(directory)` — session is
 *   created lazily on the first `send()` via `session.create()` (one chat =
 *   one session).
 * - Scoped: `useChat({ sessionId, directory, projectId })` — the chat is
 *   bound to an existing session from the start: history loads via
 *   `session.messages({ path: { id: sessionId } })` (same mapping as
 *   `reload()`), `send()` prompts that session directly (no `create()`),
 *   `stop()`/`reload()` target it. `directory` (positional or option) is
 *   still forwarded as `?directory=`; `projectId` stays UI-only until the
 *   backend maps project id → directory server-side.
 *
 * - `send(text)` appends the user row immediately, then
 *   `session.prompt({ parts: [{ type: 'text', text }] })`; the assistant row
 *   is appended from the prompt response parts (`type === 'text'`).
 * - Live deltas: a `global.event()` SSE subscription (self-healing backoff
 *   1s → 15s, same as useOpencodeEvents) filters `message.part.updated` by
 *   the current session id and accumulates `streamingText` until the prompt
 *   resolves.
 * - Cancel: `stop()` aborts the in-flight prompt (`AbortController` +
 *   `session.abort()` server-side); unmount aborts the prompt AND closes
 *   the SSE stream via BOTH `AbortController.signal` and `stream.return()`.
 */
export function useChat(
  directoryOrOptions?: string | UseChatOptions,
  optionsArg?: UseChatOptions,
): UseChatResult {
  const { t } = useI18n();
  // Backward-compat: positional `directory` string still works;
  // object form adds scoped `{ sessionId, directory, projectId }`.
  const directory =
    typeof directoryOrOptions === 'string'
      ? (optionsArg?.directory ?? directoryOrOptions)
      : (directoryOrOptions?.directory ?? optionsArg?.directory);
  const initialSessionId =
    typeof directoryOrOptions === 'string'
      ? optionsArg?.sessionId
      : (directoryOrOptions?.sessionId ?? optionsArg?.sessionId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [loading, setLoading] = useState(() => Boolean(initialSessionId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);

  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const promptCtrlRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const streamingRef = useRef('');
  const attemptRef = useRef(0);

  useEffect(() => {
    streamingRef.current = streamingText;
  }, [streamingText]);

  // Live SSE deltas for the active session (self-healing backoff).
  useEffect(() => {
    let disposed = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sub: Awaited<ReturnType<typeof opencode.global.event>> | null = null;
    // Absolute-text fallback: track the last emitted length per part so a
    // full-text (no-delta) frame only appends its growth.
    const partLens = new Map<string, number>();

    const scheduleReconnect = () => {
      if (disposed) return;
      attemptRef.current += 1;
      const delay = Math.min(BASE_DELAY_MS * 2 ** (attemptRef.current - 1), MAX_DELAY_MS);
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
      try {
        const next = await opencode.global.event({ signal: ctrl.signal });
        if (disposed || ctrl.signal.aborted) {
          await next.stream.return(undefined).catch(() => null);
          return;
        }
        const active = next;
        sub = active;
        attemptRef.current = 0;
        try {
          for await (const raw of active.stream) {
            if (disposed || ctrl.signal.aborted) break;
            const ev = raw as OpencodeEvent;
            const sid = eventSessionId(ev);
            if (!sid || sid !== sessionIdRef.current) continue;
            const payload = (ev as { payload?: { type?: string } }).payload;
            if (payload?.type !== 'message.part.updated') continue;
            const props = (ev as unknown as {
              payload: { part?: { id?: string }; delta?: unknown };
            }).payload;
            const delta = eventDelta(ev);
            if (!delta) continue;
            if (typeof props.delta === 'string' && props.delta) {
              setStreamingText((prev) => prev + props.delta);
            } else {
              // Absolute text without delta — append growth only.
              const partId =
                typeof props.part?.id === 'string' ? props.part.id : 'default';
              const seen = partLens.get(partId) ?? 0;
              if (delta.length > seen) {
                partLens.set(partId, delta.length);
                const growth = delta.slice(seen);
                setStreamingText((prev) => prev + growth);
              }
            }
          }
        } finally {
          await active.stream.return(undefined).catch(() => null);
          if (sub === active) sub = null;
        }
        scheduleReconnect();
      } catch (e: unknown) {
        if (disposed || (e as Error)?.name === 'AbortError' || ctrl?.signal.aborted) return;
        setError(formatError(e, t.errors.unexpected));
        scheduleReconnect();
      }
    };

    attemptRef.current = 0;
    void connect();

    return () => {
      disposed = true;
      ctrl?.abort();
      if (timer) clearTimeout(timer);
      const pending = sub;
      sub = null;
      void pending?.stream.return(undefined).catch(() => null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, t]);

  // Scoped mode: bind to the given sessionId + load its history
  // (same entry → ChatMessage mapping as reload()).
  useEffect(() => {
    if (!initialSessionId) return;
    let cancelled = false;
    sessionIdRef.current = initialSessionId;
    setSessionId(initialSessionId);
    setStreamingText('');
    setMessages([]);
    setError(null);
    setLoading(true);
    opencode.session
      .messages(
        directory
          ? { path: { id: initialSessionId }, query: { directory } }
          : { path: { id: initialSessionId } },
      )
      .then((res) => {
        if (cancelled) return;
        if (res.error !== undefined || res.data === undefined) {
          setError(formatError(res.error, t.errors.unexpected));
          return;
        }
        const next: ChatMessage[] = [];
        for (const entry of res.data) {
          const role = entry.info?.role === 'assistant' ? 'assistant' : 'user';
          const text = (entry.parts ?? [])
            .filter(
              (p): p is Extract<typeof p, { type: 'text' }> =>
                (p as { type?: string }).type === 'text',
            )
            .map((p) => (p as { text?: string }).text ?? '')
            .join('\n\n');
          if (!text) continue;
          next.push({ id: entry.info?.id ?? newId(), role, text });
        }
        setMessages(next);
      })
      .catch((e: unknown) => {
        if (cancelled || (e as Error)?.name === 'AbortError') return;
        setError(formatError(e, t.errors.unexpected));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId, directory]);

  // Abort any in-flight prompt on unmount (SSE cleanup lives above).
  useEffect(
    () => () => {
      promptCtrlRef.current?.abort();
      promptCtrlRef.current = null;
    },
    [],
  );

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const res = await opencode.session.create(
      directory ? { body: {}, query: { directory } } : { body: {} },
    );
    if (res.error !== undefined || res.data === undefined) {
      throw res.error ?? new Error('Unexpected error');
    }
    sessionIdRef.current = res.data.id;
    setSessionId(res.data.id);
    partReset();
    return res.data.id;
    function partReset() {
      // Fresh session — deltas accumulate from zero.
      setStreamingText('');
    }
  }, [directory]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      setError(null);
      setStreamingText('');
      const userMsg: ChatMessage = { id: newId(), role: 'user', text: trimmed };
      setMessages((prev) => [...prev, userMsg]);
      try {
        const sessionId = await ensureSession();
        const ctrl = new AbortController();
        promptCtrlRef.current = ctrl;
        const res = await opencode.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text: trimmed }] },
          ...(directory ? { query: { directory } } : {}),
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        if (res.error !== undefined || res.data === undefined) {
          setError(formatError(res.error, t.errors.unexpected));
          return;
        }
        const parts = (res.data.parts ?? []) as Array<{
          type?: string;
          text?: unknown;
        }>;
        const answer = parts
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text as string)
          .join('\n\n');
        const fallbackStream = streamingRef.current;
        const finalText = answer || fallbackStream;
        if (finalText) {
          setMessages((prev) => [
            ...prev,
            { id: res.data.info?.id ?? newId(), role: 'assistant', text: finalText },
          ]);
        }
        setStreamingText('');
      } catch (e: unknown) {
        if ((e as Error)?.name === 'AbortError') return;
        setError(formatError(e, t.errors.unexpected));
      } finally {
        promptCtrlRef.current = null;
        sendingRef.current = false;
        setSending(false);
      }
    },
    [directory, ensureSession, t],
  );

  const stop = useCallback(() => {
    promptCtrlRef.current?.abort();
    promptCtrlRef.current = null;
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      void opencode.session
        .abort(
          directory ? { path: { id: sessionId }, query: { directory } } : { path: { id: sessionId } },
        )
        .catch(() => null);
    }
    // Keep the partial stream as the assistant answer so nothing is lost.
    const partial = streamingRef.current;
    if (partial) {
      setMessages((prev) => [...prev, { id: newId(), role: 'assistant', text: partial }]);
      setStreamingText('');
    }
    sendingRef.current = false;
    setSending(false);
  }, [directory]);

  const reload = useCallback(() => {
    setError(null);
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      // No session yet — just redial the SSE stream.
      attemptRef.current = 0;
      setNonce((n) => n + 1);
      return;
    }
    setLoading(true);
    opencode.session
      .messages(
        directory
          ? { path: { id: sessionId }, query: { directory } }
          : { path: { id: sessionId } },
      )
      .then((res) => {
        if (res.error !== undefined || res.data === undefined) {
          setError(formatError(res.error, t.errors.unexpected));
          return;
        }
        const next: ChatMessage[] = [];
        for (const entry of res.data) {
          const role = entry.info?.role === 'assistant' ? 'assistant' : 'user';
          const text = (entry.parts ?? [])
            .filter(
              (p): p is Extract<typeof p, { type: 'text' }> =>
                (p as { type?: string }).type === 'text',
            )
            .map((p) => (p as { text?: string }).text ?? '')
            .join('\n\n');
          if (!text) continue;
          next.push({ id: entry.info?.id ?? newId(), role, text });
        }
        setMessages(next);
      })
      .catch((e: unknown) => {
        setError(formatError(e, t.errors.unexpected));
      })
      .finally(() => {
        setLoading(false);
        attemptRef.current = 0;
        setNonce((n) => n + 1);
      });
  }, [directory, t]);

  return {
    messages,
    streamingText,
    loading,
    sending,
    error,
    isEmpty: !loading && !error && messages.length === 0 && !streamingText,
    sessionId,
    send,
    stop,
    reload,
  };
}
