/**
 * Session + chat contracts.
 *
 * Mirrors contracts/openapi.yaml components/schemas: Session, ChatMessage,
 * SendChatRequest, SendChatResponse, MessagesResponse (field-for-field).
 * Previously duplicated in apps/backend/src/contracts.ts and
 * apps/frontend/src/api/types.ts — this package is the single source.
 */

/** GET /api/v1/session — live upstream session (503 when opencode unreachable) */
export type Session = {
  id: string;
  title: string;
  /** ISO-8601 timestamp */
  createdAt: string;
  /** model name when known */
  model?: string;
};

/** Single chat message */
export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatMessage = {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  /** ISO-8601 timestamp */
  createdAt: string;
};

/** POST /api/v1/chat request body */
export type SendChatRequest = {
  /** omit to let the backend use the active upstream session */
  sessionId?: string;
  message: string;
};

/** POST /api/v1/chat response (live upstream reply; 503 when unreachable) */
export type SendChatResponse = {
  sessionId: string;
  /** assistant reply */
  message: ChatMessage;
};

/** GET /api/v1/messages?sessionId=… */
export type MessagesResponse = {
  sessionId: string;
  messages: ChatMessage[];
};
