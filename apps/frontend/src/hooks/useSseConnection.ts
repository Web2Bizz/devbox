'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { listSessionMessages, sessionEventStream } from '../api/sessions-client';
import {
  mergeTextAndLiveTools,
  toChatEntries,
  type ChatEntryToolStatus,
} from '../lib/chat-chain';
import type { UseChatChain } from './useChatChain';
import type { UseChatTurns } from './useChatTurns';
import {
  parseApproval,
  parseApprovalDetail,
  parseFrameText,
  parseReasoning,
  parseReasoningDetail,
  parseToolDetail,
  parseToolName,
} from './useChatFrames';

const CONNECTION_BASE_DELAY_MS = 1000;
const CONNECTION_MAX_DELAY_MS = 15000;
// Watchdog (C4): the server heartbeats every ~15s (sse-relay HEARTBEAT_MS),
// so silence beyond 2 missed pings + margin means a dead socket, not idle.
const CONNECTION_WATCHDOG_MS = 40_000;
// Sending insurance (C4): a turn silent this long is verified against REST
// history (lost terminator) instead of hanging forever.
const STUCK_SENDING_MS = 90_000;

/**
 * Live accumulators of the in-flight turn (SSE sidecar, never durable):
 * `streamingRef`/`reasoningRef` hold the partial answer / thinking trace.
 * State mirrors exist only to re-render the live commit path — the thread
 * itself renders from `entries` (durable text + live tool/reasoning rows).
 * Cleared on finalize/session change (see turns).
 */
export function useChatLiveAccumulators() {
  const [streamingText, setStreamingText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  // streamingRef is the accumulator of truth (the SSE loop appends to it
  // synchronously); `streamingText` state mirrors it for the commit path.
  // reasoningRef is the same for the live thinking trace — never chat
  // text, never durable, cleared like the stream.
  const streamingRef = useRef('');
  const reasoningRef = useRef('');

  const resetLive = useCallback(() => {
    streamingRef.current = '';
    setStreamingText('');
    reasoningRef.current = '';
    setReasoningText('');
  }, []);

  const resetReasoning = useCallback(() => {
    reasoningRef.current = '';
    setReasoningText('');
  }, []);

  return {
    streamingText,
    setStreamingText,
    reasoningText,
    setReasoningText,
    streamingRef,
    reasoningRef,
    resetLive,
    resetReasoning,
  };
}

export type ChatLiveAccumulators = ReturnType<typeof useChatLiveAccumulators>;

/**
 * Live SSE deltas + idle finalization for the active session
 * (self-healing: quiet backoff redial, watchdog, resync — C4).
 *
 * Deliberately stays on `useEffect`, NOT React Query: streaming/SSE live
 * deltas do not fit the query cache (AGENTS.md streaming exception — the
 * justification comment lives here by contract).
 */
export function useSseConnection(params: {
  projectId?: string;
  chain: UseChatChain;
  turns: UseChatTurns;
}): void {
  const { projectId, chain, turns } = params;

  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    // Absolute-snapshot fallback: track the emitted length per part so
    // a full-text (no-delta) frame only appends its growth.
    const partLens = new Map<string, number>();

    const appendLiveText = (text: string): void => {
      turns.live.streamingRef.current += text;
      turns.live.setStreamingText(turns.live.streamingRef.current);
    };

    const appendLiveReasoning = (text: string): void => {
      turns.live.reasoningRef.current += text;
      turns.live.setReasoningText(turns.live.reasoningRef.current);
    };

    const clearWatchdog = (): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      turns.attemptRef.current += 1;
      const delay = Math.min(
        CONNECTION_BASE_DELAY_MS * 2 ** (turns.attemptRef.current - 1),
        CONNECTION_MAX_DELAY_MS,
      );
      timer = setTimeout(() => {
        if (!disposed) void connect();
      }, delay);
    };

    // Stuck-sending insurance: if the terminator was lost mid-turn, REST
    // history outgrows the local thread — adopt it and clear `sending`
    // instead of hanging forever. Quiet by contract (never setError here:
    // transient REST failures retry on the next watchdog cycle).
    // Durable vs live: REST is the source of truth (durable verbatim, live
    // only appended via mergeTextAndLiveTools) — confirmed user rows are
    // never rewritten, only missing live rows are appended. The trigger is
    // id-based (any durable id absent locally), not a length comparison:
    // a tool-only turn grows no text, so lengths alone would miss it or
    // overwrite the optimistic user.
    const verifyStuckSending = async (): Promise<void> => {
      if (disposed || !turns.sendingRef.current || turns.abortedTurnRef.current) return;
      const since = turns.sendingSinceRef.current;
      if (since === null || Date.now() - since < STUCK_SENDING_MS) return;
      const sid = turns.sessionIdRef.current;
      if (!sid || !projectId) return;
      try {
        const rows = await listSessionMessages(projectId, sid);
        if (disposed || !turns.sendingRef.current || turns.abortedTurnRef.current) return;
        const nextText = toChatEntries(rows);
        const prevIds = new Set(chain.entriesRef.current.map((entry) => entry.id));
        const hasNewDurable = nextText.some((entry) => !prevIds.has(entry.id));
        // Tool-content parity: a durable tool projection (`receipt:*`) may
        // carry the same live burst under a different id — merge dedupes it
        // by content, so adopt the merge whenever it adds anything.
        const merged = mergeTextAndLiveTools(nextText, chain.entriesRef.current);
        if (!hasNewDurable && merged.length === chain.entriesRef.current.length) return;
        const lastMerged = merged[merged.length - 1];
        const nextLeaf: string | null = lastMerged ? lastMerged.id : chain.leafIdRef.current;
        chain.setEntries(merged);
        chain.setLeafId(nextLeaf);
        turns.live.resetLive();
        turns.sendingRef.current = false;
        turns.sendingSinceRef.current = null;
        turns.setSending(false);
        turns.setActiveAgentId(null);
        turns.setActiveToolName(null);
        turns.traceFlagsRef.current.reasoningStarted = false;
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
      }, CONNECTION_WATCHDOG_MS);
    };

    const onActivity = (): void => {
      turns.lastActivityRef.current = Date.now();
      turns.attemptRef.current = 0;
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
          ...(turns.sessionIdRef.current ? { sessionId: turns.sessionIdRef.current } : {}),
          ...(turns.lastEventIdRef.current ? { lastEventId: turns.lastEventIdRef.current } : {}),
          onActivity,
        })) {
          if (disposed || active.signal.aborted) break;
          // Late frames of an aborted turn (stop()) are dropped — the partial
          // answer is already committed and sending is cleared. The NEXT
          // send() resets abortedTurnRef, re-arming the subscription.
          if (turns.abortedTurnRef.current) continue;
          const sid = turns.sessionIdRef.current;
          if (!sid || frame.session !== sid) continue;
          // Terminal error channel — never the text tract, never finalize().
          if (frame.type === 'stream.error') {
            turns.failTerminal(frame);
            continue;
          }
          // Resume cursor tracks OWN-session frames only (and never the
          // synthetic stream.error id, which is absent from the server
          // buffer): a foreign/terminal id would corrupt our replay position
          // after a redial.
          turns.lastEventIdRef.current = frame.id;
          // Approval gate (WEB-19 / D1): `session.approval.requested` parks
          // the turn on `awaiting_approval`, `session.approval.resolved`
          // releases it. State-only (UI in D2): the thread stays untouched —
          // no resetLive/finalize here, so neither streamed text nor durable
          // history is lost; `sending` stays parked until idle/resolve.
          const approval = parseApproval(frame);
          if (approval) {
            if (approval.kind === 'requested') {
              turns.setApproval({ status: 'awaiting_approval', reason: approval.reason });
              if (!turns.traceFlagsRef.current.approval) {
                turns.traceFlagsRef.current.approval = true;
                turns.pushTrace(
                  'approval',
                  'session.approval.requested',
                  parseApprovalDetail(frame, approval.reason) ?? 'awaiting_approval',
                );
              }
            } else {
              // Resolved (approve resumes on the same thread, reject parks
              // on paused + idle follows): clear the gate, keep the thread.
              turns.setApproval(null);
              turns.traceFlagsRef.current.approval = false;
              turns.pushTrace(
                'approval',
                'session.approval.resolved',
                parseApprovalDetail(frame, approval.reason) ?? approval.decision,
              );
            }
            continue;
          }
          const toolName = parseToolName(frame);
          if (toolName) {
            // Host tool lifecycle (session.tool.*) and legacy non-text
            // parts: live status + an additive per-turn `tool` trace row —
            // then CONTINUE past the text tract. Tool payloads NEVER enter
            // `appendLiveText()`/`streamingRef`/`partLens`, so the streamed answer
            // stays clean; `finalize()` still owns the commit.
            turns.setActiveToolName(toolName);
            const toolDetail = parseToolDetail(frame);
            // Unified chain: the same live tool turn lands as a homogeneous
            // `tool` entry (durable REST never carries it — reload preserves
            // the sidecar, the text projection stays clean).
            const toolStatus: ChatEntryToolStatus =
              frame.type === 'session.tool.success'
                ? 'done'
                : frame.type === 'session.tool.failed'
                  ? 'failed'
                  : frame.type === 'session.tool.progress' ||
                      frame.type.startsWith('session.tool.input.')
                    ? 'progress'
                    : 'called';
            chain.appendToolLive(toolName, toolDetail, toolStatus);
            const toolFlags = turns.traceFlagsRef.current;
            if (frame.type === 'session.tool.success' || frame.type === 'session.tool.failed') {
              if (!toolFlags.toolDone.has(toolName)) {
                toolFlags.toolDone.add(toolName);
                turns.pushTrace(
                  'tool',
                  toolName,
                  toolDetail ?? (frame.type === 'session.tool.failed' ? 'failed' : 'done'),
                );
              }
            } else if (frame.type === 'session.tool.progress') {
              // Throttled: first progress per turn only, never per-frame.
              if (!toolFlags.toolProgress) {
                toolFlags.toolProgress = true;
                turns.pushTrace('tool', toolName, toolDetail ?? 'progress');
              }
            } else if (!toolFlags.toolCalled.has(toolName)) {
              // session.tool.called, session.tool.input.started
              // (called-equivalent when the runner skips `called`), and
              // legacy non-text part frames — once per tool per turn.
              toolFlags.toolCalled.add(toolName);
              turns.pushTrace('tool', toolName, toolDetail ?? 'called');
            }
            // First frame of the bound session on this connection — the SSE
            // subscription is live. Once per connection (redials log again).
            if (!turns.traceFlagsRef.current.connected) {
              turns.traceFlagsRef.current.connected = true;
              turns.pushTrace('sse', 'SSE /api/v1/sessions/events connected');
            }
            continue;
          }
          // First frame of the bound session on this connection — the SSE
          // subscription is live. Once per connection (redials log again).
          if (!turns.traceFlagsRef.current.connected) {
            turns.traceFlagsRef.current.connected = true;
            turns.pushTrace('sse', 'SSE /api/v1/sessions/events connected');
          }
          const reasoning = parseReasoning(frame);
          if (reasoning) {
            if (reasoning.kind === 'delta') {
              appendLiveReasoning(reasoning.text);
            } else if (reasoning.kind === 'full') {
              if (!turns.live.reasoningRef.current.includes(reasoning.text)) {
                appendLiveReasoning(reasoning.text);
              }
            }
            // Unified chain: live reasoning lands as a homogeneous `tool`
            // entry named `reasoning` (live SSE sidecar, reload parity with
            // durable kind=reasoning rows).
            chain.appendToolLive(
              'reasoning',
              parseReasoningDetail(
                frame,
                reasoning.kind === 'started' ? null : reasoning.text,
              ) ?? 'thinking',
              reasoning.kind === 'full' ? 'done' : 'progress',
            );
            if (!turns.traceFlagsRef.current.reasoningStarted) {
              turns.traceFlagsRef.current.reasoningStarted = true;
              turns.pushTrace(
                'reasoning',
                'reasoning',
                parseReasoningDetail(
                  frame,
                  reasoning.kind === 'started' ? null : reasoning.text,
                ) ?? 'thinking',
              );
            }
            if (!turns.traceFlagsRef.current.connected) {
              turns.traceFlagsRef.current.connected = true;
              turns.pushTrace('sse', 'SSE /api/v1/sessions/events connected');
            }
            continue;
          }
          const ft = parseFrameText(frame);
          if (!ft) continue;
          // Backend turn failure: terminal, commits the partial answer and
          // surfaces the fixed error (never a spinner without an error).
          if (ft.kind === 'failed') {
            turns.failTurn(frame);
            continue;
          }
          // The subscription accumulates REGARDLESS of `sending` (F5-dogon:
          // after reload sending=false but the thread must catch up); only
          // `finalize()` is gated on a live turn (see below).
          if (ft.kind === 'idle') {
            turns.finalize();
            continue;
          }
          // Frame transitions only: first delta, ended, turn commit — never
          // every delta.
          if (frame.type === 'session.text.delta' && !turns.traceFlagsRef.current.delta) {
            turns.traceFlagsRef.current.delta = true;
            turns.pushTrace('sse', 'session.text.delta', 'text.delta started');
          }
          if (frame.type === 'session.text.ended' && !turns.traceFlagsRef.current.ended) {
            turns.traceFlagsRef.current.ended = true;
            turns.pushTrace('sse', 'session.text.ended', 'text.ended');
          }
          if (
            (frame.type === 'session.execution.succeeded' ||
              frame.type === 'session.step.ended') &&
            !turns.traceFlagsRef.current.committed
          ) {
            turns.traceFlagsRef.current.committed = true;
            turns.pushTrace('sse', frame.type, 'turn committed');
          }
          if (ft.kind === 'full') {
            // Complete text of a block (opencode 2.2.0 session.text.ended).
            // Ensure streamingRef has it: if deltas already captured it, no-op;
            // otherwise append so a missed-delta block is not lost.
            if (
              !turns.live.streamingRef.current.endsWith(ft.text) &&
              !turns.live.streamingRef.current.includes(ft.text)
            ) {
              appendLiveText(ft.text);
            } else if (
              turns.live.streamingRef.current.length < ft.text.length &&
              !turns.live.streamingRef.current.endsWith(ft.text)
            ) {
              // partial capture: replace trailing with full text
              turns.live.streamingRef.current = ft.text;
              turns.live.setStreamingText(turns.live.streamingRef.current);
            }
            continue;
          }
          if (ft.kind === 'delta') {
            // Part ids are runner-unique (prt_*), so the part key alone
            // dedups delta↔snapshot interleaving within and across messages.
            const key = `${ft.messageId}:${ft.partId}`;
            partLens.set(key, (partLens.get(key) ?? 0) + ft.text.length);
            appendLiveText(ft.text);
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
                appendLiveText(ft.text.slice(first[1]));
              }
            } else if (
              !turns.live.streamingRef.current.endsWith(ft.text) &&
              !turns.live.streamingRef.current.includes(ft.text)
            ) {
              appendLiveText(ft.text);
            }
            continue;
          }
          const matches = [...partLens.entries()].filter(([k]) => k.endsWith(`:${ft.partId}`));
          const seen = matches.length > 0 ? Math.max(...matches.map(([, v]) => v)) : 0;
          if (ft.text.length > seen) {
            const target = matches.length === 1 && matches[0] ? matches[0][0] : `:${ft.partId}`;
            partLens.set(target, ft.text.length);
            appendLiveText(ft.text.slice(seen));
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
      const sid = turns.sessionIdRef.current;
      turns.traceFlagsRef.current.connected = false;
      if (!sid || !projectId) {
        turns.attemptRef.current = 0;
        turns.redialConnection();
        return;
      }
      listSessionMessages(projectId, sid)
        .then((rows) => {
          if (disposed) return;
          chain.mergeHistory(rows);
        })
        .catch(() => {
          /* transient — keep the local thread, redial anyway */
        })
        .finally(() => {
          if (disposed) return;
          turns.attemptRef.current = 0;
          turns.redialConnection();
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

    turns.attemptRef.current = 0;
    turns.lastActivityRef.current = Date.now();
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
    // Stable-callback deps: the effect body reads `chain`/`turns` only via
    // refs + stable `useCallback([])`/`setState` fns, so listing them keeps
    // the closure fresh without redialing on every render (stale-closure fix
    // after the useChat decomposition — `chain`/`turns` identities change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    turns.connectionNonce,
    projectId,
    turns.pushTrace,
    turns.finalize,
    turns.failTerminal,
    turns.failTurn,
    turns.redialConnection,
    turns.live.resetLive,
    turns.setActiveAgentId,
    turns.setActiveToolName,
    turns.setSending,
    turns.setApproval,
    chain.appendToolLive,
    chain.mergeHistory,
    chain.setEntries,
    chain.setLeafId,
  ]);
}
