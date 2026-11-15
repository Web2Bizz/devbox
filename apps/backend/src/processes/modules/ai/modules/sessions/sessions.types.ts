/**
 * Sessions domain types shared by the harness and its pure utilities.
 *
 * Types only — no runtime logic. The service-side state shapes (bindings,
 * recorder buffers, turn meta, SSE frames), the messaging turn input and the
 * artifact projection shapes (Provider.Info subset + activation gate) live
 * here so utilities can stay harness-free.
 */
import type { SendMessageInput } from './sessions.dto';

/** Host session id → durable domain binding (NEVER trusted across projects). */
export type HostBinding = { projectId: string; localSessionId: string; userId?: string };

/** One message turn as the messaging zone hands it to a transport. */
export type SessionTurnInput = {
  userId: string;
  sessionId: string;
  body: SendMessageInput;
  directory: string;
  agentId: string;
  correlationId: string;
};

/**
 * In-flight assistant text per host assistant message (recorder).
 *
 * `createdAt` is the upstream frame's epoch-millis stamp kept in the live
 * buffer only — NOT a wire field: it is converted via
 * `new Date(createdAt).toISOString()` at the durable boundary
 * (`session_messages.createdAt`), so the ISO-8601 timestamp rule holds on
 * every shape that crosses the wire.
 */
export type AssistantBuffer = {
  sessionID: string;
  assistantMessageID: string;
  text: string;
  createdAt: number;
};

/** Owner/agent context of the last prompt, used for durable assistant rows. */
export type TurnMeta = {
  userId: string;
  projectId: string;
  agentId: string;
  mode?: 'auto' | 'ask';
  /**
   * Host-owned user receipt of the current turn (HostTurnService sets it
   * right after sessionPrompt). The recorder parents the turn's durable
   * chain to this id — the first tool/reasoning link, then the assistant
   * closing on the last link — never to findTailId at flush time (which
   * could already be the next turn's user row).
   */
  receiptId?: string;
};

/** Buffered harness-owned SSE frame (live transport only, never durable). */
export type BufferedFrame = { id: string; type: string; data: Record<string, unknown> };

/**
 * Gated project scope (projectId + jailed content directory) — the shape the
 * C4 gate answers (`ProjectAccessService.resolveProjectDirectory`). The gate
 * owns the contract; this alias only names it for the sessions services.
 */
export type GatedProjectScope = { projectId: string; directory: string };

/** Activation gate as a real type (artifact Provider.Info.activation enum). */
export type ProviderActivation = 'auto' | 'enabled' | 'disabled';

/**
 * Provider row — artifact Provider.Info. Only the fields the domain
 * projection reads are typed; settings/headers/body stay unread (headers
 * may carry auth material — never projected outward).
 */
export type UpstreamProviderInfo = {
  id?: unknown;
  name?: unknown;
  activation?: unknown;
  package?: unknown;
};
