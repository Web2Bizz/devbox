'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionMessage, SessionStreamFrame } from '@rush-code/contracts';
import {
  sessionMessagePartDeltaFrameSchema,
  sessionMessagePartUpdatedFrameSchema,
} from '@rush-code/contracts';
import { ApiClientError } from '../api/client';
import {
  DEFAULT_AGENT_ID,
  interruptSession,
  createSession,
  ensureSessionAuth,
  listSessionMessages,
  sendSessionMessage,
  sessionEventStream,
  toErrorMessage,
} from '../api/sessions-client';
import { useI18n } from '../i18n';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

export type UseChatOptions = {
  /** Existing session to scope the chat to (session = chat). */
  sessionId?: string;
  /** Rush Code project uuid — the C4 gate on every domain call. */
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
  /** Agent answering the next prompt (registry id; default 'ask', survives reload). */
  agentId: string;
  setAgentId: (agentId: string) => void;
  send: (text: string, opts?: { agentId?: string }) => Promise<void>;
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
 * Domain thread rows → chat rows. `SessionMessage` is the normalized
 * server projection (boundary-parsed in api/client): rows whose variant
 * carries no chat text (shell/compaction/…) come as `text: null` and are
 * skipped — nothing is invented client-side.
 */
function toChatMessages(rows: SessionMessage[]): ChatMessage[] {
  const next: ChatMessage[] = [];
  for (const row of rows) {
    if (row.text === null) continue;
    next.push({
      id: row.id,
      role: row.type === 'assistant' ? 'assistant' : 'user',
      text: row.text,
    });
  }
  return next;
}

/**
 * Chat text carried by one stream frame, when the variant is a text
 * mutation: `message.part.delta` (append `data.delta`) or
 * `message.part.updated` (absolute snapshot `data.part.text`). Both are
 * parsed with the narrow contract schemas — a frame that does not match
 * its variant schema is NOT this signal and is skipped (safeParse, never
 * a cast). `session.idle` (scope: top-level `session`) tells the caller
 * the answer finished.
 */
type FrameText =
  | { kind: 'delta'; text: string; partId: string; messageId: string }
  | { kind: 'snapshot'; text: string; partId: string | null }
  | { kind: 'full'; text: string }
  | { kind: 'idle' }
  | null;

function frameText(frame: SessionStreamFrame): FrameText {
  // opencode 2.2.0 native stream (provenance: contracts/opencode-stand-2.2.0.json
  // eventFrames.usedVariants): text deltas arrive as session.text.delta with
  // data.delta, the complete text as session.text.ended with data.text, and
  // session.execution.succeeded signals the end of the turn. These are the
  // types the live runner actually emits — the legacy message.part.* /
  // session.idle names do not exist on 2.2.0.
  if (frame.type === 'session.text.delta') {
    const data = frame.data as { delta?: unknown; sessionID?: unknown };
    if (typeof data.delta !== 'string' || !data.delta) return null;
    return { kind: 'delta', text: data.delta, partId: 'default', messageId: 'default' };
  }
  if (frame.type === 'session.text.ended') {
    const data = frame.data as { text?: unknown };
    if (typeof data.text === 'string' && data.text) {
      return { kind: 'full', text: data.text };
    }
    return { kind: 'idle' };
  }
  if (frame.type === 'session.execution.succeeded' || frame.type === 'session.step.ended') {
    return { kind: 'idle' };
  }
  // legacy SDK-shape (kept for backward compat if backend ever switches):
  if (frame.type === 'message.part.delta') {
    const parsed = sessionMessagePartDeltaFrameSchema.safeParse(frame);
    if (!parsed.success) return null;
    // Only text-field deltas render as chat: the runner also streams
    // deltas for non-text fields (thinking/reasoning internals) — those
    // are not chat text and are skipped, never appended.
    if (parsed.data.data.field !== 'text') return null;
    if (!parsed.data.data.delta) return null;
    return {
      kind: 'delta',
      text: parsed.data.data.delta,
      partId: parsed.data.data.partID,
      messageId: parsed.data.data.messageID,
    };
  }
  if (frame.type === 'message.part.updated') {
    const parsed = sessionMessagePartUpdatedFrameSchema.safeParse(frame);
    if (!parsed.success) return null;
    // part internals (type/text/id) are variant-owned passthrough — the
    // envelope proves `part` is an object, the text fields stay guarded.
    const part = parsed.data.data.part as {
      type?: unknown;
      text?: unknown;
      id?: unknown;
    };
    if (part.type !== 'text' || typeof part.text !== 'string' || !part.text) return null;
    return {
      kind: 'snapshot',
      text: part.text,
      partId: typeof part.id === 'string' && part.id ? part.id : null,
    };
  }
  if (frame.type === 'session.idle') return { kind: 'idle' };
  return null;
}

function formatError(e: unknown, fallback: string): string {
  const formatted = toErrorMessage(e);
  return formatted === 'Unexpected error' ? fallback : formatted;
}

function projectGateError(): ApiClientError {
  // Honest client-side gate — the domain route answers the same fixed
  // PROJECT_REQUIRED 400. Never a default project, never an anonymous
  // global call. Surfaced as a value (never thrown from effect bodies).
  return new ApiClientError({
    code: 'PROJECT_REQUIRED',
    message: 'projectId is required — session routes are project-scoped',
    status: 400,
    correlationId: 'client',
  });
}

/**
 * Chat over the domain contract (`/api/sessions*`, api/sessions-client) —
 * the frontend knows nothing about the underlying runner.
 *
 * Deliberately stays on `useEffect`, NOT React Query: streaming/SSE live
 * deltas do not fit the query cache (AGENTS.md streaming exception — the
 * justification comment lives here by contract).
 *
 * Two modes (session = chat):
 * - Lazy: `useChat({ projectId })` — the session is created on the first
 *   `send()` via `POST /api/sessions` (one chat = one session).
 * - Scoped: `useChat({ sessionId, projectId })` — bound to an existing
 *   session: history loads via `GET /api/sessions/{id}/messages`,
 *   `send()` queues that session directly (no create).
 *
 * - `send(text)` appends the user row, queues the prompt via
 *   `POST /api/sessions/{id}/messages` (the answer does NOT come from this
 *   response — it streams over events), and stays `sending` until the
 *   session's `session.idle` frame commits the streamed text as the
 *   assistant row.
 * - Live deltas: `GET /api/sessions/events` SSE subscription (self-healing
 *   backoff 1s → 15s, same as useSessionEvents), scoped by the frame's
 *   top-level `session` field (never an upstream id name at the domain
 *   layer); `message.part.delta` appends, `message.part.updated` appends
 *   the growth of its absolute snapshot (part-keyed).
 * - Cancel: `stop()` commits the partial stream as the assistant answer so
 *   nothing is lost and fires a best-effort server interrupt
 *   (POST /api/sessions/{id}/interrupt — the domain route; an idle session
 *   answers interrupted=false, never an error). Unmount aborts the
 *   in-flight queue POST and closes the SSE stream via the AbortController
 *   signal.
 */
export function useChat(options?: UseChatOptions): UseChatResult {
  const { t } = useI18n();
  const initialSessionId = options?.sessionId;
  const projectId = options?.projectId;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [loading, setLoading] = useState(() => Boolean(initialSessionId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  // Agent answering the next prompt (registry id, default 'ask'). Plain
  // state — survives reload() (reload only refetches history + redials SSE).
  const [agentId, setAgentId] = useState<string>(DEFAULT_AGENT_ID);

  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const promptCtrlRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  // streamingRef is the accumulator of truth (the SSE loop appends to it
  // synchronously); `streamingText` state mirrors it for rendering.
  const streamingRef = useRef('');
  const attemptRef = useRef(0);

  const resetStream = useCallback(() => {
    streamingRef.current = '';
    setStreamingText('');
  }, []);

  // Live SSE deltas + idle finalization for the active session
  // (self-healing backoff).
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Absolute-snapshot fallback: track the last emitted length per part so
    // a full-text (no-delta) frame only appends its growth.
    const partLens = new Map<string, number>();

    const append = (text: string): void => {
      streamingRef.current += text;
      setStreamingText(streamingRef.current);
    };

    // session.idle for the bound session — the queued answer is done:
    // commit whatever streamed and clear `sending`.
    const finalize = (): void => {
      if (!sendingRef.current) return;
      const partial = streamingRef.current;
      if (partial) {
        setMessages((prev) => [...prev, { id: newId(), role: 'assistant', text: partial }]);
      }
      resetStream();
      sendingRef.current = false;
      setSending(false);
    };

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
      ctrl = new AbortController();
      const active = ctrl;
      try {
        for await (const frame of sessionEventStream(projectId, active.signal)) {
          if (disposed || active.signal.aborted) break;
          // After stop() (user cancellation) no more frames should be
          // committed — the partial answer is already saved and sending
          // is cleared. Drop everything until the next send() (which
          // resets sendingRef via resetStream + setSending(true)).
          if (!sendingRef.current) continue;
          const sid = sessionIdRef.current;
          if (!sid || frame.session !== sid) continue;
          const ft = frameText(frame);
          if (!ft) continue;
          if (ft.kind === 'idle') {
            finalize();
            continue;
          }
          if (ft.kind === 'full') {
            // Complete text of a block (opencode 2.2.0 session.text.ended).
            // Ensure streamingRef has it: if deltas already captured it, no-op;
            // otherwise append so a missed-delta block is not lost.
            if (
              !streamingRef.current.endsWith(ft.text) &&
              !streamingRef.current.includes(ft.text)
            ) {
              append(ft.text);
            } else if (streamingRef.current.length < ft.text.length && !streamingRef.current.endsWith(ft.text)) {
              // partial capture: replace trailing with full text
              streamingRef.current = ft.text;
              setStreamingText(streamingRef.current);
            }
            continue;
          }
          if (ft.kind === 'delta') {
            // Part ids are runner-unique (prt_*), so the part key alone
            // dedups delta↔snapshot interleaving within and across messages.
            const key = `${ft.messageId}:${ft.partId}`;
            partLens.set(key, (partLens.get(key) ?? 0) + ft.text.length);
            append(ft.text);
            continue;
          }
          // Snapshot: append only the growth beyond what was emitted. An
          // id-less snapshot cannot key reliably — attribute it to the
          // single live part when there is exactly one, otherwise append
          // only text never seen before (dedup against the whole stream so
          // a re-sent full snapshot never double-flushes).
          if (ft.partId === null) {
            if (partLens.size === 1) {
              const first = [...partLens.entries()][0];
              if (first && ft.text.length > first[1]) {
                partLens.set(first[0], ft.text.length);
                append(ft.text.slice(first[1]));
              }
            } else if (
              !streamingRef.current.endsWith(ft.text) &&
              !streamingRef.current.includes(ft.text)
            ) {
              append(ft.text);
            }
            continue;
          }
          const matches = [...partLens.entries()].filter(([k]) => k.endsWith(`:${ft.partId}`));
          const seen = matches.length > 0 ? Math.max(...matches.map(([, v]) => v)) : 0;
          if (ft.text.length > seen) {
            const target = matches.length === 1 && matches[0] ? matches[0][0] : `:${ft.partId}`;
            partLens.set(target, ft.text.length);
            append(ft.text.slice(seen));
          }
        }
        if (disposed || active.signal.aborted) return;
        scheduleReconnect();
      } catch (e: unknown) {
        if (disposed || (e as Error)?.name === 'AbortError' || active.signal.aborted) return;
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
    };
  }, [nonce, projectId, t]);

  // Scoped mode: bind to the given sessionId + load its history
  // (same rows → ChatMessage mapping as reload()).
  useEffect(() => {
    if (!initialSessionId) return;
    let cancelled = false;
    sessionIdRef.current = initialSessionId;
    setSessionId(initialSessionId);
    resetStream();
    setMessages([]);
    setError(null);
    if (!projectId) {
      // Honest gate, no request fired (same contract as the backend 400).
      setLoading(false);
      setError(formatError(projectGateError(), t.errors.unexpected));
      return;
    }
    setLoading(true);
    listSessionMessages(projectId, initialSessionId)
      .then((rows) => {
        if (cancelled) return;
        setMessages(toChatMessages(rows));
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
  }, [initialSessionId, projectId]);

  // Abort any in-flight queue POST on unmount (SSE cleanup lives above).
  useEffect(
    () => () => {
      promptCtrlRef.current?.abort();
      promptCtrlRef.current = null;
    },
    [],
  );

  const ensureSession = useCallback(
    async (agentOverride?: string): Promise<string> => {
      if (sessionIdRef.current) return sessionIdRef.current;
      if (!projectId) throw projectGateError();
      const effective = agentOverride ?? agentId;
      const created = await createSession({ projectId, agentId: effective });
      sessionIdRef.current = created.id;
      setSessionId(created.id);
      // Fresh session — deltas accumulate from zero.
      resetStream();
      return created.id;
    },
    [projectId, resetStream, agentId],
  );

  const send = useCallback(
    async (text: string, opts?: { agentId?: string }) => {
      const trimmed = text.trim();
      if (!trimmed || sendingRef.current) return;
      if (!projectId) {
        setError(formatError(projectGateError(), t.errors.unexpected));
        return;
      }
      const effective = opts?.agentId ?? agentId;
      sendingRef.current = true;
      setSending(true);
      setError(null);
      resetStream();
      const userMsg: ChatMessage = { id: newId(), role: 'user', text: trimmed };
      setMessages((prev) => [...prev, userMsg]);
      try {
        await ensureSessionAuth();
        const sid = await ensureSession(effective);
        const ctrl = new AbortController();
        promptCtrlRef.current = ctrl;
        // The POST returns only after the whole backend turn (long Auto
        // chains take minutes — hence the long send timeout); the answer
        // streams over events and `sending` clears on the session.idle
        // frame (or stop()). Abort arrives via this signal (stop()/unmount).
        await sendSessionMessage(projectId, sid, trimmed, {
          signal: ctrl.signal,
          agentId: effective,
        });
      } catch (e: unknown) {
        if ((e as Error)?.name === 'AbortError') return;
        setError(formatError(e, t.errors.unexpected));
        sendingRef.current = false;
        setSending(false);
      } finally {
        promptCtrlRef.current = null;
      }
    },
    [projectId, ensureSession, resetStream, t, agentId],
  );

  const stop = useCallback(() => {
    promptCtrlRef.current?.abort();
    promptCtrlRef.current = null;
    const sid = sessionIdRef.current;
    if (sid && projectId) {
      // Best-effort server interrupt (idle answers interrupted=false).
      void interruptSession(projectId, sid).catch(() => null);
    }
    // Keep the partial stream as the assistant answer so nothing is lost.
    const partial = streamingRef.current;
    if (partial) {
      setMessages((prev) => [...prev, { id: newId(), role: 'assistant', text: partial }]);
    }
    resetStream();
    sendingRef.current = false;
    setSending(false);
  }, [projectId, resetStream]);

  const reload = useCallback(() => {
    setError(null);
    const sid = sessionIdRef.current;
    if (!sid) {
      // No session yet — just redial the SSE stream.
      attemptRef.current = 0;
      setNonce((n) => n + 1);
      return;
    }
    if (!projectId) {
      setError(formatError(projectGateError(), t.errors.unexpected));
      return;
    }
    setLoading(true);
    listSessionMessages(projectId, sid)
      .then((rows) => {
        setMessages(toChatMessages(rows));
      })
      .catch((e: unknown) => {
        setError(formatError(e, t.errors.unexpected));
      })
      .finally(() => {
        setLoading(false);
        attemptRef.current = 0;
        setNonce((n) => n + 1);
      });
  }, [projectId, t]);

  return {
    messages,
    streamingText,
    loading,
    sending,
    error,
    isEmpty: !loading && !error && messages.length === 0 && !streamingText,
    sessionId,
    agentId,
    setAgentId,
    send,
    stop,
    reload,
  };
}
