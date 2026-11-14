'use client';

import { useMemo } from 'react';
import { useChatChain } from './useChatChain';
import { useSseConnection } from './useSseConnection';
import { useChatTurns } from './useChatTurns';
import type { UseChatOptions, UseChatResult } from './useChatTypes';

export type { ChatApprovalState, ChatMessage, ChatToolEvent, FrameApproval, FrameReasoning, FrameText, UseChatOptions, UseChatResult } from './useChatTypes';

/**
 * Chat over the domain contract (`/api/v1/sessions*`, api/sessions-client) —
 * the frontend knows nothing about the underlying runner.
 *
 * Deliberately stays on `useEffect`, NOT React Query: streaming/SSE live
 * deltas do not fit the query cache (AGENTS.md streaming exception — the
 * justification comment lives here by contract).
 *
 * Thin assembly: chain state lives in `useChatChain`, turn actions in
 * `useChatTurns`, the live SSE subscription in `useSseConnection`.
 * This module only wires the three together and projects the result.
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
 *   assistant row. `session.execution.failed` / `session.step.failed` are the
 *   failure terminators: the partial stream is committed and the fixed
 *   `data.message` surfaces as the error (no spinner without an error).
 * - Live deltas: `GET /api/v1/sessions/events` SSE subscription (self-healing:
 *   quiet backoff 1s → 15s on transient breaks, watchdog redial on silence,
 *   resync on online/visible, resume via Last-Event-ID), scoped by the frame's
 *   top-level `session` field (never an upstream id name at the domain
 *   layer); `message.part.delta` appends, `message.part.updated` appends
 *   the growth of its absolute snapshot (part-keyed). Host tool frames
 *   (`session.tool.called/progress/success/failed`, `session.tool.input.*`)
 *   project to the live sidecar `activeToolName` + a homogeneous `tool`
 *   chain entry (ephemeral SSE status — never appended to the streamed
 *   text); `session.reasoning.*` lands as a `reasoning` chain entry.
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
  const initialSessionId = options?.sessionId;
  const projectId = options?.projectId;

  const chain = useChatChain();
  const turns = useChatTurns({ projectId, initialSessionId, chain });
  useSseConnection({ projectId, chain, turns });

  const isEmpty = useMemo(
    () =>
      !turns.loading &&
      !turns.error &&
      chain.messages.length === 0 &&
      !turns.live.streamingText &&
      !turns.live.reasoningText,
    [turns.loading, turns.error, chain.messages, turns.live.streamingText, turns.live.reasoningText],
  );

  return {
    messages: chain.messages,
    entries: chain.entries,
    leafId: chain.activeLeafId,
    activeLeaf: chain.activeLeaf,
    variants: chain.textVariants,
    variantIndex: chain.variantIndex,
    variantCount: chain.variantCount,
    selectLeaf: chain.selectLeaf,
    revertTo: chain.revertTo,
    loading: turns.loading,
    sending: turns.sending,
    error: turns.error,
    isEmpty,
    sessionId: turns.sessionId,
    agentId: turns.agentId,
    setAgentId: turns.setAgentId,
    activeAgentId: turns.activeAgentId,
    activeToolName: turns.activeToolName,
    approval: turns.approval,
    send: turns.send,
    stop: turns.stop,
    reload: turns.reload,
  };
}
