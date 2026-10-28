'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { opencode, ensureOpencodeAuth, projectScope, toErrorMessage } from '../api/opencode-client';
import type { OpencodeEvent } from '../api/opencode-client';
import { useI18n } from '../i18n';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

export type UseChatOptions = {
  /** Existing opencode session to scope the chat to (session = chat). */
  sessionId?: string;
  /** Opencode working directory, forwarded as `?directory=` (backend-ignored). */
  directory?: string;
  /** Rush Code project id (prj-*) — forwarded as `?projectId=` (backend-gated, C4). */
  projectId?: string;
};

export type UseChatResult = {
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
};

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/**
 * Map a `session.messages` payload to chat rows.
 *
 * Primary shape is the flat v2 `SessionMessage`
 * (`{ id, type: 'user' | 'assistant' | …, text?/content? }` — user/system/
 * synthetic carry `text`, assistant carries `content: [{ type: 'text',
 * text }]`); the legacy `{ info: Message, parts: Part[] }` envelope is
 * kept as a fallback because the backend mirror still serves the legacy
 * `/session/*` namespace (see opencode.controller.ts listMessages).
 * Non-assistant roles render as user rows (same as before); entries
 * without displayable text (shell/compaction/…) are skipped.
 */
function toChatMessages(data: unknown): ChatMessage[] {
  if (!Array.isArray(data)) return [];
  const next: ChatMessage[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as {
      id?: unknown;
      type?: unknown;
      text?: unknown;
      content?: unknown;
      info?: { id?: unknown; role?: unknown };
      parts?: unknown;
    };
    // Flat v2 SessionMessage (has a top-level `type`, no `info`).
    if (typeof e.type === 'string' && e.info === undefined) {
      const id = typeof e.id === 'string' ? e.id : newId();
      const role = e.type === 'assistant' ? 'assistant' : 'user';
      let text = '';
      if (typeof e.text === 'string') {
        text = e.text;
      } else if (Array.isArray(e.content)) {
        text = (e.content as Array<{ type?: unknown; text?: unknown }>)
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text as string)
          .join('\n\n');
      }
      if (!text) continue;
      next.push({ id, role, text });
      continue;
    }
    // Legacy `{ info, parts }` envelope (backend mirror passthrough).
    const role = e.info?.role === 'assistant' ? 'assistant' : 'user';
    const text = Array.isArray(e.parts)
      ? (e.parts as Array<{ type?: unknown; text?: unknown }>)
        .filter((p) => p?.type === 'text')
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('\n\n')
      : '';
    if (!text) continue;
    next.push({ id: typeof e.info?.id === 'string' ? e.info.id : newId(), role, text });
  }
  return next;
}

/** Session id carried by an SSE payload, when the event is session-scoped.
 * v1 frames nest under `payload.properties`; native v2 `Event` frames are
 * flat (`{ type, properties: { sessionID, … } }`) — both shapes are read,
 * v2 first (see dist/v2/gen/types.gen.d.ts `Event*` types). */
function eventSessionId(ev: OpencodeEvent): string | null {
  const flat = (ev as { properties?: unknown }).properties as
    | { sessionID?: unknown; part?: { sessionID?: unknown }; info?: { sessionID?: unknown } }
    | undefined;
  if (flat && typeof flat === 'object') {
    if (typeof flat.sessionID === 'string') return flat.sessionID;
    if (flat.part && typeof flat.part.sessionID === 'string') return flat.part.sessionID;
    if (flat.info && typeof flat.info.sessionID === 'string') return flat.info.sessionID;
  }
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

/** Text delta carried by `message.part.updated` (absolute text fallback).
 * v2 servers send `message.part.delta` (`properties.delta`) or full-part
 * `message.part.updated` (`properties.part`) — both flat, no `payload`. */
function eventDelta(ev: OpencodeEvent): string | null {
  const flat = ev as {
    type?: string;
    properties?: { delta?: unknown; part?: { type?: unknown; text?: unknown; id?: unknown } };
  };
  if (flat.type === 'message.part.delta' && typeof flat.properties?.delta === 'string' && flat.properties.delta) {
    return flat.properties.delta;
  }
  if (flat.type === 'message.part.updated') {
    const part = flat.properties?.part;
    if (part?.type === 'text' && typeof part.text === 'string' && part.text) return part.text;
  }
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
 *   `session.messages({ sessionID })` (same mapping as
 *   `reload()`), `send()` prompts that session directly (no `create()`),
 *   `stop()`/`reload()` target it. `directory` (positional or option) is
 *   still forwarded as `?directory=` (backend-ignored); `projectId` travels
 *   as `?projectId=` via the shared `projectScope()` helper on every
 *   session call (missing → honest 400 PROJECT_REQUIRED as error state).
 *
 * - `send(text)` appends the user row immediately, then
 *   `session.prompt({ parts: [{ type: 'text', text }] })`; the assistant row
 *   is appended from the prompt response parts (`type === 'text'`).
 * - Live deltas: an `event.subscribe()` SSE subscription (self-healing backoff
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
  // C4: projectId rides every session call as `?projectId=` (projectScope);
  // event.subscribe stays global (no project key — see SSE effect below).
  const projectId =
    typeof directoryOrOptions === 'string'
      ? optionsArg?.projectId
      : (directoryOrOptions?.projectId ?? optionsArg?.projectId);
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
    let sub: Awaited<ReturnType<typeof opencode.event.subscribe>> | null = null;
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
        const next = await opencode.event.subscribe(undefined, { signal: ctrl.signal });
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
            // v1 nests under `payload`, v2 is flat (`type`/`properties`).
            const flat = ev as {
              type?: string;
              properties?: { part?: { id?: string }; delta?: unknown };
            };
            const payload = (ev as { payload?: { type?: string } }).payload;
            const frameType = flat.type ?? payload?.type;
            if (frameType !== 'message.part.updated' && frameType !== 'message.part.delta') {
              continue;
            }
            const props = (flat.properties ?? payload) as unknown as {
              part?: { id?: string };
              delta?: unknown;
            } | undefined;
            const delta = eventDelta(ev);
            if (!delta || !props) continue;
            if (typeof props.delta === 'string' && props.delta) {
              setStreamingText((prev) => prev + (props.delta as string));
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
      .messages({
        sessionID: initialSessionId,
        ...(directory ? { directory } : {}),
        ...projectScope(projectId),
      })
      .then((res) => {
        if (cancelled) return;
        if (res.error !== undefined || res.data === undefined) {
          setError(formatError(res.error, t.errors.unexpected));
          return;
        }
        setMessages(toChatMessages(res.data));
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
  }, [initialSessionId, directory, projectId]);

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
    const res = await opencode.session.create({
      ...(directory ? { directory } : {}),
      ...projectScope(projectId),
    });
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
  }, [directory, projectId]);

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
        await ensureOpencodeAuth();
        const sessionId = await ensureSession();
        const ctrl = new AbortController();
        promptCtrlRef.current = ctrl;
        const res = await opencode.session.prompt(
          {
            sessionID: sessionId,
            parts: [{ type: 'text', text: trimmed }],
            ...(directory ? { directory } : {}),
            ...projectScope(projectId),
          },
          { signal: ctrl.signal },
        );
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
    [directory, projectId, ensureSession, t],
  );

  const stop = useCallback(() => {
    promptCtrlRef.current?.abort();
    promptCtrlRef.current = null;
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      void opencode.session
        .abort({
          sessionID: sessionId,
          ...(directory ? { directory } : {}),
          ...projectScope(projectId),
        })
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
  }, [directory, projectId]);

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
      .messages({
        sessionID: sessionId,
        ...(directory ? { directory } : {}),
        ...projectScope(projectId),
      })
      .then((res) => {
        if (res.error !== undefined || res.data === undefined) {
          setError(formatError(res.error, t.errors.unexpected));
          return;
        }
        setMessages(toChatMessages(res.data));
      })
      .catch((e: unknown) => {
        setError(formatError(e, t.errors.unexpected));
      })
      .finally(() => {
        setLoading(false);
        attemptRef.current = 0;
        setNonce((n) => n + 1);
      });
  }, [directory, projectId, t]);

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
