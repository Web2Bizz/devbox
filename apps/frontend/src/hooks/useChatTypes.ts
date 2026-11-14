import type { SessionCheckpointStatus } from '@rush-code/contracts';
import type { ChatEntry, ChatRowMessage } from '../lib/chat-chain';

/** Single chat row — reuse of the chain text projection (see chat-chain). */
export type ChatMessage = ChatRowMessage;

/**
 * One chronological entry of the tool timeline: every real domain call the
 * current chat turn performs, in call order (auth → create-session →
 * history → prompt → SSE → interrupt). Host tool lifecycle
 * (`session.tool.called/progress/success/failed`) appends additive `tool`
 * rows and host reasoning (`session.reasoning.started/delta/ended`)
 * appends additive `reasoning` rows — both ephemeral live SSE status, never
 * durable history. Rendered by `ChatToolsTimeline` — append-only per
 * session, never reordered.
 *
 * Durable vs live (explicit): `messages`/`entries` come from REST history
 * (Postgres, survive reload); the live SSE sidecar (`streamingRef`/
 * `reasoningRef` in useSseConnection, `activeToolName` here) is live-only
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
    | 'reasoning'
    | 'approval';
  label: string;
  detail?: string;
};

/**
 * Approval gate of the parked turn (WEB-19 / D1 — state only, UI in D2).
 * `status` reuses the contracts checkpoint lifecycle (`awaiting_approval`);
 * `reason` is the short human-readable pause cause from
 * `session.approval.requested` (never secrets). Null when no turn is parked —
 * `session.approval.resolved` clears it, the thread stays untouched (no loss).
 */
export type ChatApprovalState = {
  status: Extract<SessionCheckpointStatus, 'awaiting_approval'>;
  reason: string;
};

export type UseChatOptions = {
  /** Existing session to scope the chat to (session = chat). */
  sessionId?: string;
  /** Rush Code project uuid — the C4 gate on every domain call. */
  projectId?: string;
};

export type UseChatResult = {
  messages: Array<ChatMessage>;
  /** Unified chain: durable text (REST) + live tool (SSE) in one homogeneous array. */
  entries: Array<ChatEntry>;
  /** Active branch tip (scoped: SSE finalize parents to it, thread renders its chain). */
  leafId: string | null;
  activeLeaf: ChatEntry | null;
  variants: Array<ChatEntry>;
  variantIndex: number;
  variantCount: number;
  selectLeaf: (id: string) => void;
  revertTo: (messageId: string) => void;
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
  /** Live sidecar: tool name of the in-flight turn (null when idle/text-only). */
  activeToolName: string | null;
  /** Approval gate of the parked turn (null when no turn awaits approval). */
  approval: ChatApprovalState | null;
  send: (text: string, opts?: { agentId?: string }) => Promise<void>;
  stop: () => void;
  reload: () => void;
};

/**
 * Chat text carried by one stream frame, when the variant is a text
 * mutation: `message.part.delta` (append `data.delta`) or
 * `message.part.updated` (absolute snapshot `data.part.text`). Both are
 * parsed with the narrow contract schemas — a frame that does not match
 * its variant schema is NOT this signal and is skipped (safeParse, never
 * a cast). `session.idle` (scope: top-level `session`) tells the caller
 * the answer finished.
 */
export type FrameText =
  | { kind: 'delta'; text: string; partId: string; messageId: string }
  | { kind: 'snapshot'; text: string; partId: string | null }
  | { kind: 'full'; text: string }
  | { kind: 'idle' }
  | { kind: 'failed' }
  | null;

export type FrameReasoning =
  | { kind: 'delta'; text: string }
  | { kind: 'full'; text: string }
  | { kind: 'started' }
  | null;

/**
 * Approval gate carried by one stream frame (WEB-19 / D1):
 * `session.approval.requested` parks the turn (`awaiting_approval` + reason),
 * `session.approval.resolved` releases it (`approve` resumes, `reject` parks
 * on `paused` + idle follows). `requested` is validated with the narrow
 * contract schema (safeParse, never a cast); `resolved` has no contract
 * schema yet (backend-emitted `decision` + optional `reason`) and is read
 * with guarded field access — never throws, never invents.
 */
export type FrameApproval =
  | { kind: 'requested'; reason: string }
  | { kind: 'resolved'; decision: 'approve' | 'reject'; reason?: string }
  | null;
