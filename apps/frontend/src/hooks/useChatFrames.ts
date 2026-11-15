import type { SessionStreamFrame } from '@rush-code/contracts';
import {
  sessionApprovalRequestedFrameSchema,
  sessionMessagePartDeltaFrameSchema,
  sessionMessagePartUpdatedFrameSchema,
  sessionReasoningFrameSchema,
  sessionTextDeltaFrameSchema,
  sessionTextEndedFrameSchema,
  sessionToolLifecycleFrameSchema,
} from '@rush-code/contracts';
import { ApiClientError } from '../api/client';
import { toErrorMessage } from '../api/sessions-client';
import type { FrameApproval, FrameReasoning, FrameText } from './useChatTypes';

export function newChatId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

export function formatChatError(e: unknown, fallback: string): string {
  const formatted = toErrorMessage(e);
  return formatted === 'Unexpected error' ? fallback : formatted;
}

export function buildProjectGateError(): ApiClientError {
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

export function parseFrameText(frame: SessionStreamFrame): FrameText {
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
  // Terminal failure frames (backend turn died before the answer): a
  // terminal signal like idle, but it surfaces `data.message` and keeps the
  // partial text. `stream.error` (transport) stays a separate channel.
  if (frame.type === 'session.execution.failed' || frame.type === 'session.step.failed') {
    return { kind: 'failed' };
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

/**
 * Host tool lifecycle frames the live runner emits (opencode 2.2.x
 * `session.tool.*`): called → (input.* | progress)* → success/failed.
 * `session.tool.input.*` frames carry argument deltas, not the answer —
 * they resolve the same tool name and feed timeline detail, never text.
 */
export const TOOL_FRAME_TYPES = new Set([
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
 * `session.reasoning.*` is deliberately NOT a tool frame: thinking lands
 * as a live `reasoning` chain entry (see parseReasoning) + the SSE live
 * sidecar, never `activeToolName`.
 */
export function parseToolName(frame: SessionStreamFrame): string | null {
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
export function parseToolDetail(frame: SessionStreamFrame): string | undefined {
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
 * Live approval gate frames the runner emits (`session.approval.requested` /
 * `session.approval.resolved`): the turn parks on `awaiting_approval` and is
 * released by the human decision. Transport-only live signal, never chat
 * text — the chat keeps the thread untouched and only flips the approval
 * state (see useSseConnection). Durable vs live: the parked row lives in
 * `agent_checkpoints.status`, these frames are the live projection.
 */
export const APPROVAL_FRAME_TYPES = new Set([
  'session.approval.requested',
  'session.approval.resolved',
]);

export function parseApproval(frame: SessionStreamFrame): FrameApproval {
  if (!APPROVAL_FRAME_TYPES.has(frame.type)) return null;
  if (frame.type === 'session.approval.requested') {
    const parsed = sessionApprovalRequestedFrameSchema.safeParse(frame);
    if (!parsed.success) return null;
    return { kind: 'requested', reason: parsed.data.data.reason };
  }
  // session.approval.resolved — no contract schema yet: guarded read of the
  // backend-emitted decision (+ optional human note), never a cast.
  const data = frame.data as Record<string, unknown>;
  const decision = data.decision;
  if (decision !== 'approve' && decision !== 'reject') return null;
  const reason = data.reason;
  if (typeof reason === 'string' && reason.length > 0) {
    return { kind: 'resolved', decision, reason };
  }
  return { kind: 'resolved', decision };
}

/**
 * Short timeline detail for an approval frame: single-lined reason snippet
 * (truncated) or the lifecycle phase fallback. Never secrets.
 */
export function parseApprovalDetail(frame: SessionStreamFrame, reason?: string): string | undefined {
  if (!APPROVAL_FRAME_TYPES.has(frame.type)) return undefined;
  const raw = reason ?? (frame.data as Record<string, unknown>).reason;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const singleLine = raw.replace(/\s+/g, ' ').trim();
    return singleLine.length > 120 ? `${singleLine.slice(0, 117)}…` : singleLine;
  }
  if (frame.type === 'session.approval.requested') return 'awaiting_approval';
  return 'resolved';
}

/**
 * Live reasoning frames the runner emits (`session.reasoning.started/delta/
 * ended`): thinking trace of the turn, never chat text. Validated with the
 * narrow contract schema (safeParse, never a cast) — a frame that does not
 * match is NOT this signal.
 */
export const REASONING_FRAME_TYPES = new Set([
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
]);

export function parseReasoning(frame: SessionStreamFrame): FrameReasoning {
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
export function parseReasoningDetail(
  frame: SessionStreamFrame,
  text: string | null,
): string | undefined {
  if (!REASONING_FRAME_TYPES.has(frame.type)) return undefined;
  if (text !== null && text.trim().length > 0) {
    const singleLine = text.replace(/\s+/g, ' ').trim();
    return singleLine.length > 120 ? `${singleLine.slice(0, 117)}…` : singleLine;
  }
  if (frame.type === 'session.reasoning.started') return 'started';
  if (frame.type === 'session.reasoning.delta') return 'thinking';
  return 'done';
}
