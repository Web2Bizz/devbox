'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  DEFAULT_AGENT_ID as DEFAULT_MODE_ID,
  createSession,
  ensureSessionAuth,
  interruptSession,
  listSessionMessages,
  sendSessionMessage,
} from '../api/sessions-client';
import { useI18n } from '../i18n';
import type { UseChatChain } from './useChatChain';
import { useChatLiveAccumulators, type ChatLiveAccumulators } from './useSseConnection';
import { buildProjectGateError, formatChatError, newChatId } from './useChatFrames';
import type { ChatApprovalState, ChatToolEvent } from './useChatTypes';

export type TurnTraceFlags = {
  connected: boolean;
  delta: boolean;
  ended: boolean;
  committed: boolean;
  approval: boolean;
  toolCalled: Set<string>;
  toolProgress: boolean;
  toolDone: Set<string>;
  reasoningStarted: boolean;
};

function freshTraceFlags(): TurnTraceFlags {
  return {
    connected: false,
    delta: false,
    ended: false,
    committed: false,
    approval: false,
    toolCalled: new Set<string>(),
    toolProgress: false,
    toolDone: new Set<string>(),
    reasoningStarted: false,
  };
}

export type UseChatTurns = {
  sessionId: string | null;
  sessionIdRef: MutableRefObject<string | null>;
  /** UI: режим работы (состояние пикера). */
  modeId: string;
  setModeId: Dispatch<SetStateAction<string>>;
  /** UI: режим работы, владеющий in-flight turn (null when idle). */
  activeModeId: string | null;
  activeToolName: string | null;
  /** Approval gate of the parked turn (null when no turn awaits approval). */
  approval: ChatApprovalState | null;
  sending: boolean;
  sendingRef: MutableRefObject<boolean>;
  abortedTurnRef: MutableRefObject<boolean>;
  sendingSinceRef: MutableRefObject<number | null>;
  promptCtrlRef: MutableRefObject<AbortController | null>;
  loading: boolean;
  error: string | null;
  toolTrace: Array<ChatToolEvent>;
  traceFlagsRef: MutableRefObject<TurnTraceFlags>;
  lastEventIdRef: MutableRefObject<string | null>;
  lastActivityRef: MutableRefObject<number>;
  attemptRef: MutableRefObject<number>;
  connectionNonce: number;
  redialConnection: () => void;
  live: ChatLiveAccumulators;
  pushTrace: (kind: ChatToolEvent['kind'], label: string, detail?: string) => void;
  resetTraceFlags: () => void;
  ensureSession: (modeOverride?: string) => Promise<string>;
  send: (text: string, opts?: { modeId?: string; agentId?: string }) => Promise<void>;
  stop: () => void;
  reload: () => void;
  finalize: () => void;
  failTerminal: (frame: { data?: unknown }) => void;
  failTurn: (frame: { data?: unknown }) => void;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSending: Dispatch<SetStateAction<boolean>>;
  setModeId: Dispatch<SetStateAction<string>>;
  /** @deprecated UI-алиас setModeId; wire-совместимость с внешними потребителями. */
  setAgentId: Dispatch<SetStateAction<string>>;
  /** UI: режим работы (состояние пикера, deprecated-алиас modeId). */
  agentId: string;
  /** UI: режим работы in-flight turn (deprecated-алиас activeModeId). */
  activeAgentId: string | null;
  setActiveModeId: Dispatch<SetStateAction<string | null>>;
  /** @deprecated UI-алиас setActiveModeId. */
  setActiveAgentId: Dispatch<SetStateAction<string | null>>;
  setActiveToolName: Dispatch<SetStateAction<string | null>>;
  setApproval: Dispatch<SetStateAction<ChatApprovalState | null>>;
};

export function useChatTurns(params: {
  projectId?: string;
  initialSessionId?: string;
  chain: UseChatChain;
}): UseChatTurns {
  const { projectId, initialSessionId, chain } = params;
  const { t } = useI18n();
  const live = useChatLiveAccumulators();

  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [modeId, setModeId] = useState<string>(DEFAULT_MODE_ID);
  const [activeModeId, setActiveModeId] = useState<string | null>(null);
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [approval, setApproval] = useState<ChatApprovalState | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(() => Boolean(initialSessionId));
  const [error, setError] = useState<string | null>(null);
  const [toolTrace, setToolTrace] = useState<Array<ChatToolEvent>>([]);
  const [connectionNonce, setConnectionNonce] = useState(0);

  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const promptCtrlRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const abortedTurnRef = useRef(false);
  const sendingSinceRef = useRef<number | null>(null);
  const traceFlagsRef = useRef<TurnTraceFlags>(freshTraceFlags());
  const lastEventIdRef = useRef<string | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const attemptRef = useRef(0);

  const pushTrace = useCallback(
    (kind: ChatToolEvent['kind'], label: string, detail?: string): void => {
      const event: ChatToolEvent = {
        id: newChatId(),
        at: Date.now(),
        kind,
        label,
        ...(detail ? { detail } : {}),
      };
      setToolTrace((prev) => [...prev, event]);
    },
    [],
  );

  const resetTraceFlags = useCallback((): void => {
    traceFlagsRef.current = freshTraceFlags();
  }, []);

  const redialConnection = useCallback((): void => {
    setConnectionNonce((n) => n + 1);
  }, []);

  // session.idle for the bound session — the queued answer is done:
  // commit whatever streamed and clear `sending`. Only a live turn may
  // finalize: after stop() the partial answer already belongs to the thread.
  const finalize = useCallback((): void => {
    if (!sendingRef.current || abortedTurnRef.current) return;
    const partial = live.streamingRef.current;
    if (partial) {
      chain.appendAssistantPartial(partial);
    }
    live.resetLive();
    sendingRef.current = false;
    sendingSinceRef.current = null;
    setSending(false);
    setActiveModeId(null);
    setActiveToolName(null);
    traceFlagsRef.current.reasoningStarted = false;
  }, [chain.appendAssistantPartial, live.resetLive]);

  // Terminal transport frame (C0 stream.error): the thread is PRESERVED,
  // the error surfaces separately (C6 renders it as a banner, not a
  // replacement). Transient failures never reach here — they redial quietly.
  // Replay gate: ignore terminal frames when no turn is live. A full replay
  // (cursor:null connect) replays old failed frames with sending:false —
  // they must not surface as a toast. Only a live turn (sending:true) may
  // set the error (same sendingRef gate as finalize).
  const failTerminal = useCallback(
    (frame: { data?: unknown }): void => {
      if (!sendingRef.current) return;
      const data =
        frame.data && typeof frame.data === 'object' ? (frame.data as Record<string, unknown>) : {};
      const message =
        typeof data.message === 'string' && data.message
          ? data.message
          : (t.errors.unexpected as string);
      live.resetLive();
      sendingRef.current = false;
      sendingSinceRef.current = null;
      setSending(false);
      setActiveModeId(null);
      setActiveToolName(null);
      setApproval(null);
      traceFlagsRef.current.reasoningStarted = false;
      setError(message);
    },
    [live.resetLive, t],
  );

  // Terminal backend turn failure (`session.execution.failed` /
  // `session.step.failed`): the answer produced before the failure is real,
  // so the partial stream is committed as the assistant row, then the fixed
  // error surfaces through the same terminal cleanup. Idempotent — sending
  // is cleared, so a later session.idle is a no-op.
  const failTurn = useCallback(
    (frame: { data?: unknown }): void => {
      if (!sendingRef.current) return;
      if (!abortedTurnRef.current) {
        const partial = live.streamingRef.current;
        if (partial) {
          chain.appendAssistantPartial(partial);
        }
      }
      failTerminal(frame);
    },
    [chain.appendAssistantPartial, failTerminal, live.streamingRef],
  );

  const ensureSession = useCallback(
    async (modeOverride?: string): Promise<string> => {
      if (sessionIdRef.current) return sessionIdRef.current;
      if (!projectId) throw buildProjectGateError();
      const effective = modeOverride ?? modeId;
      // UI: режим работы; wire: agentId для совместимости с backend
      const created = await createSession({ projectId, agentId: effective });
      pushTrace('create-session', 'POST /api/v1/sessions');
      sessionIdRef.current = created.id;
      lastEventIdRef.current = null;
      setSessionId(created.id);
      // Fresh session — deltas accumulate from zero.
      live.resetLive();
      return created.id;
    },
    [projectId, modeId, pushTrace, live.resetLive],
  );

  const send = useCallback(
    async (text: string, opts?: { modeId?: string; agentId?: string }) => {
      const trimmed = text.trim();
      if (!trimmed || sendingRef.current) return;
      if (!projectId) {
        setError(formatChatError(buildProjectGateError(), t.errors.unexpected));
        return;
      }
      // UI: режим работы; wire: agentId для совместимости с backend
      const effective = opts?.modeId ?? opts?.agentId ?? modeId;
      sendingRef.current = true;
      abortedTurnRef.current = false;
      sendingSinceRef.current = Date.now();
      setSending(true);
      setError(null);
      setActiveModeId(effective);
      setActiveToolName(null);
      setApproval(null);
      live.resetLive();
      // New turn on the same session: per-turn SSE transitions may log
      // again, the connection event too after a redial; history stays.
      traceFlagsRef.current.delta = false;
      traceFlagsRef.current.ended = false;
      traceFlagsRef.current.committed = false;
      traceFlagsRef.current.approval = false;
      traceFlagsRef.current.connected = false;
      traceFlagsRef.current.toolCalled = new Set<string>();
      traceFlagsRef.current.toolProgress = false;
      traceFlagsRef.current.toolDone = new Set<string>();
      traceFlagsRef.current.reasoningStarted = false;
      chain.appendUserText(trimmed);
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
          // UI: режим работы; wire: agentId для совместимости с backend
          agentId: effective,
        });
      } catch (e: unknown) {
        if ((e as Error)?.name === 'AbortError') return;
        setError(formatChatError(e, t.errors.unexpected));
        sendingRef.current = false;
        sendingSinceRef.current = null;
        setSending(false);
      } finally {
        promptCtrlRef.current = null;
      }
    },
    [projectId, ensureSession, live.resetLive, t, modeId, pushTrace, chain.appendUserText],
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
    const partial = live.streamingRef.current;
    if (partial) {
      chain.appendAssistantPartial(partial);
    }
    live.resetLive();
    sendingRef.current = false;
    sendingSinceRef.current = null;
    setSending(false);
    setActiveModeId(null);
    setActiveToolName(null);
    setApproval(null);
    traceFlagsRef.current.approval = false;
    traceFlagsRef.current.reasoningStarted = false;
  }, [projectId, live.resetLive, live.streamingRef, pushTrace, chain.appendAssistantPartial]);

  const reload = useCallback(() => {
    setError(null);
    const sid = sessionIdRef.current;
    // A redialed stream logs its fresh connect once (see the SSE loop).
    // Durable vs live: reload refetches the durable chain (REST) and
    // clears the live sidecar — streaming/reasoning accumulators never
    // survive a reload, entries stay the single source.
    traceFlagsRef.current.connected = false;
    traceFlagsRef.current.reasoningStarted = false;
    live.resetReasoning();
    if (!sid) {
      // No session yet — just redial the SSE stream.
      attemptRef.current = 0;
      setConnectionNonce((n) => n + 1);
      return;
    }
    if (!projectId) {
      setError(formatChatError(buildProjectGateError(), t.errors.unexpected));
      return;
    }
    setLoading(true);
    pushTrace('reload', `GET /api/v1/sessions/${sid}/messages`);
    listSessionMessages(projectId, sid)
      .then((rows) => {
        chain.mergeHistory(rows);
      })
      .catch((e: unknown) => {
        setError(formatChatError(e, t.errors.unexpected));
      })
      .finally(() => {
        setLoading(false);
        attemptRef.current = 0;
        setConnectionNonce((n) => n + 1);
      });
  }, [projectId, t, pushTrace, chain.mergeHistory, live.resetReasoning]);

  // Scoped mode: bind to the given sessionId + load its history
  // (same rows → entries mapping as reload()).
  // Durable vs live: history is durable (survives reload); the live SSE
  // sidecar (streaming/reasoning accumulators) is cleared here.
  useEffect(() => {
    if (!initialSessionId) return;
    let cancelled = false;
    sessionIdRef.current = initialSessionId;
    lastEventIdRef.current = null;
    abortedTurnRef.current = false;
    sendingSinceRef.current = null;
    lastActivityRef.current = Date.now();
    setSessionId(initialSessionId);
    live.resetLive();
    chain.clearChain();
    setError(null);
    setApproval(null);
    // New bound session — the tool timeline starts over.
    resetTraceFlags();
    setToolTrace([]);
    if (!projectId) {
      // Honest gate, no request fired (same contract as the backend 400).
      setLoading(false);
      setError(formatChatError(buildProjectGateError(), t.errors.unexpected));
      return;
    }
    setLoading(true);
    pushTrace('history', `GET /api/v1/sessions/${initialSessionId}/messages`);
    listSessionMessages(projectId, initialSessionId)
      .then((rows) => {
        if (cancelled) return;
        chain.replaceWithHistory(rows);
      })
      .catch((e: unknown) => {
        if (cancelled || (e as Error)?.name === 'AbortError') return;
        setError(formatChatError(e, t.errors.unexpected));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId, projectId]);

  // Abort any in-flight queue POST on unmount (SSE cleanup lives in the connection).
  useEffect(
    () => () => {
      promptCtrlRef.current?.abort();
      promptCtrlRef.current = null;
    },
    [],
  );

  return {
    sessionId,
    sessionIdRef,
    modeId,
    setModeId,
    // UI: режим работы; wire: agentId для совместимости с backend
    agentId: modeId,
    setAgentId: setModeId,
    activeModeId,
    // UI: режим работы; wire: agentId для совместимости с backend
    activeAgentId: activeModeId,
    activeToolName,
    approval,
    sending,
    sendingRef,
    abortedTurnRef,
    sendingSinceRef,
    promptCtrlRef,
    loading,
    error,
    toolTrace,
    traceFlagsRef,
    lastEventIdRef,
    lastActivityRef,
    attemptRef,
    connectionNonce,
    redialConnection,
    live,
    pushTrace,
    resetTraceFlags,
    ensureSession,
    send,
    stop,
    reload,
    finalize,
    failTerminal,
    failTurn,
    setLoading,
    setError,
    setSending,
    setActiveModeId,
    // UI: режим работы; wire: agentId для совместимости с backend
    setActiveAgentId: setActiveModeId,
    setActiveToolName,
    setApproval,
  };
}
