'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionMessage, SessionStreamFrame } from '@rush-code/contracts';
import {
  sessionMessagePartDeltaFrameSchema,
  sessionMessagePartUpdatedFrameSchema,
  sessionReasoningFrameSchema,
  sessionTextDeltaFrameSchema,
  sessionTextEndedFrameSchema,
  sessionToolLifecycleFrameSchema,
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

/**
 * One chronological entry of the tool timeline: every real domain call the
 * current chat turn performs, in call order (auth → create-session →
 * history → prompt → SSE frames → interrupt). Host tool lifecycle
 * (`session.tool.called/progress/success/failed`) appends additive `tool`
 * rows and host reasoning (`session.reasoning.started/delta/ended`)
 * appends additive `reasoning` rows — both ephemeral live SSE status, never
 * durable history. Rendered by `ChatToolsTimeline` — append-only per
 * session, never reordered.
 *
 * Durable vs live (explicit): `messages` come from REST history (Postgres,
 * survive reload); `streamingText`/`reasoningText`/`toolTrace` are live-only
 * (cleared on reload/session change/finalize, never persisted).
 */
export type ChatToolEvent = {
  id: string;
  at: number;
  kind:
    | 'auth'
    | 'create-session'
    | 'history'
    | 'prompt'
    | 'sse'
    | 'interrupt'
    | 'reload'
    | 'tool'
    | 'reasoning';
  label: string;
  detail?: string;
};

export type UseChatOptions = {
  /** Existing session to scope the chat to (session = chat). */
  sessionId?: string;
  /** Rush Code project uuid — the C4 gate on every domain call. */
  projectId?: string;
};

export type UseChatResult = {
  messages: Array<ChatMessage>;
  streamingText: string;
  /** Live thinking trace of the in-flight turn (never chat text, never durable). */
  reasoningText: string;
  loading: boolean;
  sending: boolean;
  error: string | null;
  isEmpty: boolean;
  /** Active session id (initial option or lazily created). */
  sessionId: string | null;
  /** Agent answering the next prompt (registry id; default 'ask', survives reload). */
  agentId: string;
  setAgentId: (agentId: string) => void;
  /** Agent id that owns the in-flight turn (null when idle). */
  activeAgentId: string | null;
  /** Tool name reported by the live part frames (null when idle/text-only). */
  activeToolName: string | null;
  send: (text: string, opts?: { agentId?: string }) => Promise<void>;
  stop: () => void;
  reload: () => void;
  /** Chronological tool trace of the session (append-only, reset on session change). */
  toolTrace: Array<ChatToolEvent>;
};

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;
// Watchdog (C4): the server heartbeats every ~15s (sse-relay HEARTBEAT_MS),
// so silence beyond 2 missed pings + margin means a dead socket, not idle.
const WATCHDOG_MS = 40_000;
// Sending insurance (C4): a turn silent this long is verified against REST
// history (lost terminator) instead of hanging forever.
const STUCK_SENDING_MS = 90_000;

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
function toChatMessages(rows: Array<SessionMessage>): Array<ChatMessage> {
  const next: Array<ChatMessage> = [];
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
  // Live 2.2.x stream (provenance: contracts/opencode-stand-2.2.0.json
  // eventFrames + live capture): text deltas arrive as session.text.delta
  // with data.delta, the complete text as session.text.ended with data.text,
  // and session.execution.succeeded / session.step.ended signal the end of
  // the turn. Narrow contract schemas validate the live text variants
  // (safeParse, never a cast) — a frame that does not match is NOT this
  // signal. Legacy message.part.* / session.idle stay for backward compat.
  if (frame.type === 'session.text.delta') {
    const parsed = sessionTextDeltaFrameSchema.safeParse(frame);
    if (!parsed.success) return null;
    if (!parsed.data.data.delta) return null;
    return { kind: 'delta', text: parsed.data.data.delta, partId: 'default', messageId: 'default' };
  }
  if (frame.type === 'session.text.ended') {
    const parsed = sessionTextEndedFrameSchema.safeParse(frame);
    if (!parsed.success) return null;
    if (typeof parsed.data.data.text === 'string' && parsed.data.data.text) {
      return { kind: 'full', text: parsed.data.data.text };
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

/**
 * Host tool lifecycle frames the live runner emits (opencode 2.2.x
 * `session.tool.*`): called → (input.* | progress)* → success/failed.
 * `session.tool.input.*` frames carry argument deltas, not the answer —
 * they resolve the same tool name and feed timeline detail, never text.
 */
const TOOL_FRAME_TYPES = new Set([
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.failed',
  'session.tool.input.started',
  'session.tool.input.delta',
  'session.tool.input.ended',
]);

/**
 * Guarded tool-name read of one variant-owned record: `tool`/`toolName`/
 * `name` as non-empty strings. Text parts (`type: 'text'`) are chat
 * content, not tool calls, and answer null. Anything else (missing keys,
 * wrong shapes) answers null — never throws, never invents a name.
 */
function readToolName(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === 'text') return null;
  for (const key of ['tool', 'toolName', 'name'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Tool name carried by a tool-lifecycle frame, read with guarded field
 * access (variant-owned passthrough — never a cast, never a narrowed
 * schema: the SSE envelope stays permissive/additive by contract).
 *
 * Sources, in order:
 * - legacy `message.part.updated` non-text part (`tool/toolName/name`;
 *   text parts are chat content, not tool calls, and answer null);
 * - host `session.tool.called/progress/success/failed` and
 *   `session.tool.input.*` frames: the same three keys are read at the
 *   top-level `data` record and, defensively, inside nested `call`, `part`,
 *   `tool` and `payload` objects (D1: the runner's exact nest level is not
 *   pinned — every level answers the same guarded read).
 *
 * `session.reasoning.*` is deliberately NOT a tool frame: thinking has its
 * own `reasoningText` state + `reasoning` trace rows (see frameReasoning),
 * never `activeToolName`.
 */
function frameToolName(frame: SessionStreamFrame): string | null {
  if (frame.type === 'message.part.updated') {
    const part = (frame.data as { part?: unknown }).part;
    return readToolName(part);
  }
  if (!TOOL_FRAME_TYPES.has(frame.type)) return null;
  const data = frame.data as Record<string, unknown>;
  return (
    readToolName(data) ??
    readToolName(data.call) ??
    readToolName(data.part) ??
    readToolName(data.payload) ??
    (typeof data.tool === 'object' && data.tool !== null ? readToolName(data.tool) : null)
  );
}

/**
 * Short timeline detail for a host tool frame (phase fallback when the
 * payload carries no status snippet). Free-text snippets are single-lined
 * and truncated — full argument/result bodies (and any secret material)
 * never reach the timeline or the logs.
 */
function frameToolDetail(frame: SessionStreamFrame): string | undefined {
  const parsed = sessionToolLifecycleFrameSchema.safeParse(frame);
  if (!parsed.success && !TOOL_FRAME_TYPES.has(frame.type)) return undefined;
  const data = frame.data as Record<string, unknown>;
  const nestedCall =
    typeof data.call === 'object' && data.call !== null
      ? (data.call as Record<string, unknown>)
      : null;
  const candidates: Array<unknown> = [
    data.progress,
    data.message,
    data.status,
    data.text,
    nestedCall?.progress,
    nestedCall?.status,
    ...(frame.type === 'session.tool.failed' ? [data.error] : []),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const singleLine = candidate.replace(/\s+/g, ' ').trim();
      return singleLine.length > 120 ? `${singleLine.slice(0, 117)}…` : singleLine;
    }
  }
  if (frame.type === 'session.tool.called' || frame.type === 'session.tool.input.started') {
    return 'called';
  }
  if (frame.type === 'session.tool.progress' || frame.type.startsWith('session.tool.input.')) {
    return 'progress';
  }
  if (frame.type === 'session.tool.failed') return 'failed';
  if (frame.type === 'session.tool.success') return 'done';
  return undefined;
}

/**
 * Live reasoning frames the runner emits (`session.reasoning.started/delta/
 * ended`): thinking trace of the turn, never chat text. Validated with the
 * narrow contract schema (safeParse, never a cast) — a frame that does not
 * match is NOT this signal.
 */
const REASONING_FRAME_TYPES = new Set([
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
]);

type FrameReasoning =
  | { kind: 'delta'; text: string }
  | { kind: 'full'; text: string }
  | { kind: 'started' }
  | null;

function frameReasoning(frame: SessionStreamFrame): FrameReasoning {
  if (!REASONING_FRAME_TYPES.has(frame.type)) return null;
  const parsed = sessionReasoningFrameSchema.safeParse(frame);
  if (!parsed.success) return null;
  const delta = parsed.data.data.delta;
  if (typeof delta === 'string' && delta) {
    return { kind: 'delta', text: delta };
  }
  const full = parsed.data.data.text;
  if (typeof full === 'string' && full) {
    return { kind: 'full', text: full };
  }
  if (parsed.data.type === 'session.reasoning.started') {
    return { kind: 'started' };
  }
  if (parsed.data.type === 'session.reasoning.ended' && !full) {
    return { kind: 'started' };
  }
  return null;
}

/**
 * Short timeline detail for a reasoning frame: first single-lined snippet of
 * the thinking delta (truncated), phase fallback otherwise. Full thinking
 * bodies never reach the timeline or the logs.
 */
function frameReasoningDetail(frame: SessionStreamFrame, text: string | null): string | undefined {
  if (!REASONING_FRAME_TYPES.has(frame.type)) return undefined;
  if (text !== null && text.trim().length > 0) {
    const singleLine = text.replace(/\s+/g, ' ').trim();
    return singleLine.length > 120 ? `${singleLine.slice(0, 117)}…` : singleLine;
  }
  if (frame.type === 'session.reasoning.started') return 'started';
  if (frame.type === 'session.reasoning.delta') return 'thinking';
  return 'done';
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
 * Chat over the domain contract (`/api/v1/sessions*`, api/sessions-client) —
 * the frontend knows nothing about the underlying runner.
 *
 * Deliberately stays on `useEffect`, NOT React Query: streaming/SSE live
 * deltas do not fit the query cache (AGENTS.md streaming exception — the
 * justification comment lives here by contract).
 *
 * Two modes (session = chat):
 * - Lazy: `useChat({ projectId })` — the session is created on the first
 *   `send()` via `POST /api/v1/sessions` (one chat = one session).
 * - Scoped: `useChat({ sessionId, projectId })` — bound to an existing
 *   session: history loads via `GET /api/v1/sessions/{id}/messages`,
 *   `send()` queues that session directly (no create).
 *
 * - `send(text)` appends the user row, queues the prompt via
 *   `POST /api/v1/sessions/{id}/messages` (the answer does NOT come from this
 *   response — it streams over events), and stays `sending` until the
 *   session's `session.idle` frame commits the streamed text as the
 *   assistant row.
 * - Live deltas: `GET /api/v1/sessions/events` SSE subscription (self-healing:
 *   quiet backoff 1s → 15s on transient breaks, watchdog redial on silence,
 *   resync on online/visible, resume via Last-Event-ID), scoped by the frame's
 *   top-level `session` field (never an upstream id name at the domain
 *   layer); `message.part.delta` appends, `message.part.updated` appends
 *   the growth of its absolute snapshot (part-keyed). Host tool frames
  *   (`session.tool.called/progress/success/failed`, `session.tool.input.*`)
  *   project to `activeToolName` + a per-turn `tool` trace row (ephemeral SSE
  *   status — never appended to the streamed text); `session.reasoning.*` is
  *   surfaced as live reasoning steps with timeline rows.
  *   The subscription
 *   accumulates regardless of `sending` (F5 catch-up); only `finalize()` is
 *   gated on a live turn. Terminal `stream.error` surfaces separately —
 *   the thread is preserved.
 * - Cancel: `stop()` commits the partial stream as the assistant answer so
 *   nothing is lost and fires a best-effort server interrupt
 *   (POST /api/v1/sessions/{id}/interrupt — the domain route; an idle session
 *   answers interrupted=false, never an error). Unmount aborts the
 *   in-flight queue POST and closes the SSE stream via the AbortController
 *   signal.
 */
export function useChat(options?: UseChatOptions): UseChatResult {
  const { t } = useI18n();
  const initialSessionId = options?.sessionId;
  const projectId = options?.projectId;
  const [messages, setMessages] = useState<Array<ChatMessage>>([]);
  const [streamingText, setStreamingText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [loading, setLoading] = useState(() => Boolean(initialSessionId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  // Agent answering the next prompt (registry id, default 'ask'). Plain
  // state — survives reload() (reload only refetches history + redials SSE).
  const [agentId, setAgentId] = useState<string>(DEFAULT_AGENT_ID);
  // Live status: the agent that owns the in-flight turn and the tool name
  // carried by the current non-text part frame (both null while idle).
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  // Chronological tool trace (see ChatToolEvent): every real domain call of
  // the session in call order. Append-only within a session — send() of a
  // new prompt keeps appending, only a session change resets it.
  const [toolTrace, setToolTrace] = useState<Array<ChatToolEvent>>([]);

  const pushTrace = useCallback(
    (kind: ChatToolEvent['kind'], label: string, detail?: string): void => {
      const event: ChatToolEvent = {
        id: newId(),
        at: Date.now(),
        kind,
        label,
        ...(detail ? { detail } : {}),
      };
      setToolTrace((prev) => [...prev, event]);
    },
    [],
  );

  // Per-turn transition guards so SSE frame kinds are logged once per turn
  // (first text.delta, first text.ended, first turn commit, tool
  // called-once-per-tool / progress-once-per-turn / done-once-per-tool) —
  // never per delta/frame. `connected` is per connection: reset on
  // send()/reload() so a redialed stream logs its fresh connect once.
  const traceFlagsRef = useRef({
    connected: false,
    delta: false,
    ended: false,
    committed: false,
    toolCalled: new Set<string>(),
    toolProgress: false,
    toolDone: new Set<string>(),
    reasoningStarted: false,
  });
  const resetTraceFlags = useCallback((): void => {
    traceFlagsRef.current = {
      connected: false,
      delta: false,
      ended: false,
      committed: false,
      toolCalled: new Set<string>(),
      toolProgress: false,
      toolDone: new Set<string>(),
      reasoningStarted: false,
    };
  }, []);

  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const promptCtrlRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  // streamingRef is the accumulator of truth (the SSE loop appends to it
  // synchronously); `streamingText` state mirrors it for rendering.
  // reasoningRef is the same for the live thinking trace (`reasoningText`
  // mirrors it) — never chat text, never durable, cleared like the stream.
  const streamingRef = useRef('');
  const reasoningRef = useRef('');
  const attemptRef = useRef(0);
  // Self-healing refs (C4): resume cursor, watchdog liveness, abort-turn epoch,
  // and a messages mirror for the stuck-sending REST verification.
  const lastEventIdRef = useRef<string | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const abortedTurnRef = useRef(false);
  const sendingSinceRef = useRef<number | null>(null);
  const messagesRef = useRef<Array<ChatMessage>>([]);
  messagesRef.current = messages;

  const resetStream = useCallback(() => {
    streamingRef.current = '';
    setStreamingText('');
    reasoningRef.current = '';
    setReasoningText('');
  }, []);

  // Live SSE deltas + idle finalization for the active session
  // (self-healing: quiet backoff redial, watchdog, resync — C4).
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    // Absolute-snapshot fallback: track the last emitted length per part so
    // a full-text (no-delta) frame only appends its growth.
    const partLens = new Map<string, number>();

    const append = (text: string): void => {
      streamingRef.current += text;
      setStreamingText(streamingRef.current);
    };

    const appendReasoning = (text: string): void => {
      reasoningRef.current += text;
      setReasoningText(reasoningRef.current);
    };

    // session.idle for the bound session — the queued answer is done:
    // commit whatever streamed and clear `sending`. Only a live turn may
    // finalize: after stop() the partial answer already belongs to the thread.
    const finalize = (): void => {
      if (!sendingRef.current || abortedTurnRef.current) return;
      const partial = streamingRef.current;
      if (partial) {
        setMessages((prev) => [...prev, { id: newId(), role: 'assistant', text: partial }]);
      }
      resetStream();
      sendingRef.current = false;
      sendingSinceRef.current = null;
      setSending(false);
      setActiveAgentId(null);
      setActiveToolName(null);
      traceFlagsRef.current.reasoningStarted = false;
    };

    // Terminal transport frame (C0 stream.error): the thread is PRESERVED,
    // the error surfaces separately (C6 renders it as a banner, not a
    // replacement). Transient failures never reach here — they redial quietly.
    const failTerminal = (frame: { data?: unknown }): void => {
      const data =
        frame.data && typeof frame.data === 'object' ? (frame.data as Record<string, unknown>) : {};
      const message =
        typeof data.message === 'string' && data.message
          ? data.message
          : (t.errors.unexpected as string);
      resetStream();
      sendingRef.current = false;
      sendingSinceRef.current = null;
      setSending(false);
      setActiveAgentId(null);
      setActiveToolName(null);
      traceFlagsRef.current.reasoningStarted = false;
      setError(message);
    };

    const clearWatchdog = (): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      attemptRef.current += 1;
      const delay = Math.min(BASE_DELAY_MS * 2 ** (attemptRef.current - 1), MAX_DELAY_MS);
      timer = setTimeout(() => {
        if (!disposed) void connect();
      }, delay);
    };

    // Stuck-sending insurance: if the terminator was lost mid-turn, REST
    // history outgrows the local thread — adopt it and clear `sending`
    // instead of hanging forever. Quiet by contract (never setError here).
    const verifyStuckSending = async (): Promise<void> => {
      if (disposed || !sendingRef.current || abortedTurnRef.current) return;
      const since = sendingSinceRef.current;
      if (since === null || Date.now() - since < STUCK_SENDING_MS) return;
      const sid = sessionIdRef.current;
      if (!sid || !projectId) return;
      try {
        const rows = await listSessionMessages(projectId, sid);
        if (disposed || !sendingRef.current || abortedTurnRef.current) return;
        const next = toChatMessages(rows);
        if (next.length > messagesRef.current.length) {
          setMessages(next);
          resetStream();
          sendingRef.current = false;
          sendingSinceRef.current = null;
          setSending(false);
          setActiveAgentId(null);
          setActiveToolName(null);
          traceFlagsRef.current.reasoningStarted = false;
        }
      } catch {
        /* transient — the next watchdog cycle retries */
      }
    };

    const armWatchdog = (): void => {
      clearWatchdog();
      watchdog = setTimeout(() => {
        if (disposed) return;
        // Silence past the watchdog = dead socket: abort the hanging read and
        // redial quietly with the resume cursor (never setError on transient).
        void verifyStuckSending().finally(() => {
          if (disposed) return;
          try {
            ctrl?.abort();
          } catch {
            /* abort is idempotent */
          }
          scheduleReconnect();
        });
      }, WATCHDOG_MS);
    };

    const onActivity = (): void => {
      lastActivityRef.current = Date.now();
      attemptRef.current = 0;
      if (!disposed) armWatchdog();
    };

    const connect = async () => {
      if (disposed) return;
      try {
        ctrl?.abort();
      } catch {
        /* idempotent */
      }
      ctrl = new AbortController();
      const active = ctrl;
      armWatchdog();
      try {
        for await (const frame of sessionEventStream(projectId, active.signal, {
          ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
          ...(lastEventIdRef.current ? { lastEventId: lastEventIdRef.current } : {}),
          onActivity,
        })) {
          if (disposed || active.signal.aborted) break;
          // Late frames of an aborted turn (stop()) are dropped — the partial
          // answer is already committed and sending is cleared. The NEXT
          // send() resets abortedTurnRef, re-arming the subscription.
          if (abortedTurnRef.current) continue;
          const sid = sessionIdRef.current;
          if (!sid || frame.session !== sid) continue;
          // Terminal error channel — never the text tract, never finalize().
          if (frame.type === 'stream.error') {
            failTerminal(frame);
            continue;
          }
          // Resume cursor tracks OWN-session frames only (and never the
          // synthetic stream.error id, which is absent from the server
          // buffer): a foreign/terminal id would corrupt our replay position
          // after a redial.
          lastEventIdRef.current = frame.id;
          const toolName = frameToolName(frame);
          if (toolName) {
            // Host tool lifecycle (session.tool.*) and legacy non-text
            // parts: live status + an additive per-turn `tool` trace row —
            // then CONTINUE past the text tract. Tool payloads NEVER enter
            // `append()`/`streamingRef`/`partLens`, so the streamed answer
            // stays clean; `finalize()` still owns the commit.
            setActiveToolName(toolName);
            const toolDetail = frameToolDetail(frame);
            const toolFlags = traceFlagsRef.current;
            if (frame.type === 'session.tool.success' || frame.type === 'session.tool.failed') {
              if (!toolFlags.toolDone.has(toolName)) {
                toolFlags.toolDone.add(toolName);
                pushTrace(
                  'tool',
                  toolName,
                  toolDetail ?? (frame.type === 'session.tool.failed' ? 'failed' : 'done'),
                );
              }
            } else if (frame.type === 'session.tool.progress') {
              // Throttled: first progress per turn only, never per-frame.
              if (!toolFlags.toolProgress) {
                toolFlags.toolProgress = true;
                pushTrace('tool', toolName, toolDetail ?? 'progress');
              }
            } else if (!toolFlags.toolCalled.has(toolName)) {
              // session.tool.called, session.tool.input.started
              // (called-equivalent when the runner skips `called`), and
              // legacy non-text part frames — once per tool per turn.
              toolFlags.toolCalled.add(toolName);
              pushTrace('tool', toolName, toolDetail ?? 'called');
            }
            // First frame of the bound session on this connection — the SSE
            // subscription is live. Once per connection (redials log again).
            if (!traceFlagsRef.current.connected) {
              traceFlagsRef.current.connected = true;
              pushTrace('sse', 'SSE /api/v1/sessions/events connected');
            }
            continue;
          }
          // First frame of the bound session on this connection — the SSE
          // subscription is live. Once per connection (redials log again).
          if (!traceFlagsRef.current.connected) {
            traceFlagsRef.current.connected = true;
            pushTrace('sse', 'SSE /api/v1/sessions/events connected');
          }
          const reasoning = frameReasoning(frame);
          if (reasoning) {
            if (reasoning.kind === 'delta') {
              appendReasoning(reasoning.text);
            } else if (reasoning.kind === 'full') {
              if (!reasoningRef.current.includes(reasoning.text)) {
                appendReasoning(reasoning.text);
              }
            }
            if (!traceFlagsRef.current.reasoningStarted) {
              traceFlagsRef.current.reasoningStarted = true;
              pushTrace('reasoning', 'reasoning', frameReasoningDetail(frame, reasoning.kind === 'started' ? null : reasoning.text) ?? 'thinking');
            }
            if (!traceFlagsRef.current.connected) {
              traceFlagsRef.current.connected = true;
              pushTrace('sse', 'SSE /api/v1/sessions/events connected');
            }
            continue;
          }
          const ft = frameText(frame);
          if (!ft) continue;
          // The subscription accumulates REGARDLESS of `sending` (F5-dogон:
          // after reload sending=false but the thread must catch up); only
          // `finalize()` is gated on a live turn (see below).
          if (ft.kind === 'idle') {
            finalize();
            continue;
          }
          // Frame transitions only: first delta, ended, turn commit — never
          // every delta.
          if (frame.type === 'session.text.delta' && !traceFlagsRef.current.delta) {
            traceFlagsRef.current.delta = true;
            pushTrace('sse', 'session.text.delta', 'text.delta started');
          }
          if (frame.type === 'session.text.ended' && !traceFlagsRef.current.ended) {
            traceFlagsRef.current.ended = true;
            pushTrace('sse', 'session.text.ended', 'text.ended');
          }
          if (
            (frame.type === 'session.execution.succeeded' ||
              frame.type === 'session.step.ended') &&
            !traceFlagsRef.current.committed
          ) {
            traceFlagsRef.current.committed = true;
            pushTrace('sse', frame.type, 'turn committed');
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
        // Clean EOF (server ended an idle stream): quiet redial, no error.
        scheduleReconnect();
      } catch (e: unknown) {
        if (disposed || (e as Error)?.name === 'AbortError' || active.signal.aborted) return;
        // Transient transport failure — quiet backoff redial (C4): the thread
        // is preserved and NO ErrorState is set. Only stream.error (above) or
        // a failed REST history load surfaces an error.
        scheduleReconnect();
      }
    };

    // Resync (C4): online / back-to-visible → quiet history refresh + redial,
    // never setError. Listeners are cleaned on unmount.
    const resync = (): void => {
      if (disposed) return;
      const sid = sessionIdRef.current;
      traceFlagsRef.current.connected = false;
      if (!sid || !projectId) {
        attemptRef.current = 0;
        setNonce((n) => n + 1);
        return;
      }
      listSessionMessages(projectId, sid)
        .then((rows) => {
          if (disposed) return;
          setMessages(toChatMessages(rows));
        })
        .catch(() => {
          /* transient — keep the local thread, redial anyway */
        })
        .finally(() => {
          if (disposed) return;
          attemptRef.current = 0;
          setNonce((n) => n + 1);
        });
    };
    const onOnline = (): void => {
      resync();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') resync();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
      document.addEventListener('visibilitychange', onVisibility);
    }

    attemptRef.current = 0;
    lastActivityRef.current = Date.now();
    void connect();

    return () => {
      disposed = true;
      clearWatchdog();
      try {
        ctrl?.abort();
      } catch {
        /* idempotent */
      }
      if (timer) clearTimeout(timer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [nonce, projectId, t, pushTrace]);

  // Scoped mode: bind to the given sessionId + load its history
  // (same rows → ChatMessage mapping as reload()).
  // Durable vs live: history is durable (survives reload); reasoningText,
  // streamingText and toolTrace restarts are live-only (cleared here).
  useEffect(() => {
    if (!initialSessionId) return;
    let cancelled = false;
    sessionIdRef.current = initialSessionId;
    lastEventIdRef.current = null;
    abortedTurnRef.current = false;
    sendingSinceRef.current = null;
    lastActivityRef.current = Date.now();
    setSessionId(initialSessionId);
    resetStream();
    setMessages([]);
    setError(null);
    // New bound session — the tool timeline starts over.
    resetTraceFlags();
    setToolTrace([]);
    if (!projectId) {
      // Honest gate, no request fired (same contract as the backend 400).
      setLoading(false);
      setError(formatError(projectGateError(), t.errors.unexpected));
      return;
    }
    setLoading(true);
    pushTrace('history', `GET /api/v1/sessions/${initialSessionId}/messages`);
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
      pushTrace('create-session', 'POST /api/v1/sessions');
      sessionIdRef.current = created.id;
      lastEventIdRef.current = null;
      setSessionId(created.id);
      // Fresh session — deltas accumulate from zero.
      resetStream();
      return created.id;
    },
    [projectId, resetStream, agentId, pushTrace],
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
      abortedTurnRef.current = false;
      sendingSinceRef.current = Date.now();
      setSending(true);
      setError(null);
      setActiveAgentId(effective);
      setActiveToolName(null);
      resetStream();
      // New turn on the same session: per-turn SSE transitions may log
      // again, the connection event too after a redial; history stays.
      traceFlagsRef.current.delta = false;
      traceFlagsRef.current.ended = false;
      traceFlagsRef.current.committed = false;
      traceFlagsRef.current.connected = false;
      traceFlagsRef.current.toolCalled = new Set<string>();
      traceFlagsRef.current.toolProgress = false;
      traceFlagsRef.current.toolDone = new Set<string>();
      traceFlagsRef.current.reasoningStarted = false;
      const userMsg: ChatMessage = { id: newId(), role: 'user', text: trimmed };
      setMessages((prev) => [...prev, userMsg]);
      try {
        pushTrace('auth', 'auth');
        await ensureSessionAuth();
        const sid = await ensureSession(effective);
        const ctrl = new AbortController();
        promptCtrlRef.current = ctrl;
        // The POST returns only after the whole backend turn (long Auto
        // chains take minutes — hence the long send timeout); the answer
        // streams over events and `sending` clears on the session.idle
        // frame (or stop()). Abort arrives via this signal (stop()/unmount).
        pushTrace('prompt', `POST /api/v1/sessions/${sid}/messages`, effective);
        await sendSessionMessage(projectId, sid, trimmed, {
          signal: ctrl.signal,
          agentId: effective,
        });
      } catch (e: unknown) {
        if ((e as Error)?.name === 'AbortError') return;
        setError(formatError(e, t.errors.unexpected));
        sendingRef.current = false;
        sendingSinceRef.current = null;
        setSending(false);
      } finally {
        promptCtrlRef.current = null;
      }
    },
    [projectId, ensureSession, resetStream, t, agentId, pushTrace],
  );

  const stop = useCallback(() => {
    promptCtrlRef.current?.abort();
    promptCtrlRef.current = null;
    // Abort-turn epoch (C4): late frames of the interrupted turn are dropped
    // by the SSE loop (abortedTurnRef) — the partial answer below is the only
    // commit. The next send() resets the flag, re-arming the subscription.
    abortedTurnRef.current = true;
    const sid = sessionIdRef.current;
    if (sid && projectId) {
      // Best-effort server interrupt (idle answers interrupted=false).
      pushTrace('interrupt', `POST /api/v1/sessions/${sid}/interrupt`);
      void interruptSession(projectId, sid).catch(() => null);
    }
    // Keep the partial stream as the assistant answer so nothing is lost.
    const partial = streamingRef.current;
    if (partial) {
      setMessages((prev) => [...prev, { id: newId(), role: 'assistant', text: partial }]);
    }
    resetStream();
    sendingRef.current = false;
    sendingSinceRef.current = null;
    setSending(false);
    setActiveAgentId(null);
    setActiveToolName(null);
    traceFlagsRef.current.reasoningStarted = false;
  }, [projectId, resetStream, pushTrace]);

  const reload = useCallback(() => {
    setError(null);
    const sid = sessionIdRef.current;
    // A redialed stream logs its fresh connect once (see the SSE loop).
    // Durable vs live: reload refetches the durable thread (REST) and
    // clears the live thinking trace — reasoning/streaming never survive a
    // reload, the session tool timeline stays append-only.
    traceFlagsRef.current.connected = false;
    traceFlagsRef.current.reasoningStarted = false;
    reasoningRef.current = '';
    setReasoningText('');
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
    pushTrace('reload', `GET /api/v1/sessions/${sid}/messages`);
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
  }, [projectId, t, pushTrace]);

  return {
    messages,
    streamingText,
    reasoningText,
    loading,
    sending,
    error,
    isEmpty: !loading && !error && messages.length === 0 && !streamingText && !reasoningText,
    sessionId,
    agentId,
    setAgentId,
    activeAgentId,
    activeToolName,
    send,
    stop,
    reload,
    toolTrace,
  };
}
