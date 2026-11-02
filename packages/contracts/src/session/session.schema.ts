import { z } from 'zod';

import type {
  ChatMessage,
  ChatRole,
  MessagesResponse,
  SendChatRequest,
  SendChatResponse,
  Session,
  SessionsResponse,
} from './session';

/**
 * Boundary schemas for session.ts.
 * sendChatSchema is verbatim apps/backend/src/api/dto.ts (same field
 * constraints + error strings) so backend/frontend validation stays
 * identical after consumer migration. Response schemas mirror
 * contracts/openapi.yaml; scalar ids/timestamps carry min(1) so empty
 * strings fail fast (content stays unconstrained — upstream may send
 * empty deltas).
 */

export const sendChatSchema = z.object({
  sessionId: z.string().optional(),
  message: z
    .string({ error: 'Field "message" is required' })
    .min(1, { error: 'Field "message" is required' }),
}) satisfies z.ZodType<SendChatRequest>;

export type SendChatInput = z.infer<typeof sendChatSchema>;

export const chatRoleSchema = z.enum(['user', 'assistant', 'system']) satisfies z.ZodType<ChatRole>;

export const sessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** ISO-8601 timestamp */
  createdAt: z.iso.datetime({ error: 'Field "createdAt" must be an ISO-8601 timestamp' }),
  model: z.string().min(1).optional(),
}) satisfies z.ZodType<Session>;

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: chatRoleSchema,
  content: z.string(),
  /** ISO-8601 timestamp */
  createdAt: z.iso.datetime({ error: 'Field "createdAt" must be an ISO-8601 timestamp' }),
}) satisfies z.ZodType<ChatMessage>;

export const sendChatResponseSchema = z.object({
  sessionId: z.string().min(1),
  message: chatMessageSchema,
}) satisfies z.ZodType<SendChatResponse>;

export const messagesResponseSchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(chatMessageSchema),
}) satisfies z.ZodType<MessagesResponse>;

export const sessionsResponseSchema = z.array(sessionSchema) satisfies z.ZodType<SessionsResponse>;
