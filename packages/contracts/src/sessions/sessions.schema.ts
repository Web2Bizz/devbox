import { z } from 'zod';

import type {
  CreateSessionRequest,
  SendMessageRequest,
  SessionInfo,
  SessionInfoList,
  SessionInfoModel,
  SessionMessage,
  SessionMessageList,
  SessionRunStatus,
  SessionRunStatusMap,
  SessionStreamFrame,
} from './sessions';
import { opencodeSessionStatusSchema } from '../opencode-session/opencode-session.schema';

/**
 * Boundary schemas for sessions.ts (domain /api/sessions* contract).
 *
 * createSessionRequestSchema is the backend-verbatim POST validation (same
 * constraints + error strings the controller enforces); response schemas
 * mirror contracts/openapi.yaml and are for CLIENT-side parsing — the
 * shapes are ours, so nullable title/model are explicit (never optional:
 * the server always answers the key, null when unset).
 * SessionRunStatus keeps the wire union of the mirror contract (single
 * source of truth, domain name on top).
 */

export const sessionInfoModelSchema = z.object({
  id: z.string({ error: 'Field "model.id" is required' }).min(1),
  providerID: z.string({ error: 'Field "model.providerID" is required' }).min(1),
  variant: z.string().optional(),
}) satisfies z.ZodType<SessionInfoModel>;

export const sessionInfoSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  title: z.string().nullable(),
  /** ISO-8601 (matches openapi.yaml format: date-time — the service emits
   * new Date(ms).toISOString(), always a Z-suffixed instant) */
  createdAt: z.iso.datetime({ error: 'Field "createdAt" must be an ISO-8601 timestamp' }),
  directory: z.string({ error: 'Field "directory" is required' }).min(1),
  // Q2: strict like the YAML (format: uuid) — both projectId and createdAt
  // are backend-GENERATED values (gate uuid / toISOString), never upstream
  // passthrough, so tightening catches real bugs and cannot reject valid
  // answers (sessions.service.ts: projectId = narrowed gate input;
  // createdAt = new Date(time.created).toISOString()).
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  model: sessionInfoModelSchema.nullable(),
  status: opencodeSessionStatusSchema,
}) satisfies z.ZodType<SessionInfo>;

export const sessionInfoListSchema = z.array(sessionInfoSchema) satisfies z.ZodType<
  SessionInfoList
>;

/** Domain-named alias of the shared runtime-status union (single source of truth). */
export const sessionRunStatusSchema = opencodeSessionStatusSchema satisfies z.ZodType<SessionRunStatus>;

export const sessionRunStatusMapSchema = z.record(
  z.string(),
  sessionRunStatusSchema,
) satisfies z.ZodType<SessionRunStatusMap>;

/** POST /api/sessions body — projectId required (sessions are project-scoped). */
export const createSessionRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  title: z.string().min(1).max(200).optional(),
  parentID: z.string().min(1).max(200).optional(),
}) satisfies z.ZodType<CreateSessionRequest>;

export type CreateSessionInput = z.infer<typeof createSessionRequestSchema>;

/** GET /api/sessions/{id}/messages item — normalized Session.Message.Info
 * projection (text null for non-text variants; createdAt is backend-emitted
 * ISO like SessionInfo.createdAt, hence the same strict datetime). */
export const sessionMessageSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  type: z.string({ error: 'Field "type" is required' }).min(1),
  createdAt: z.iso.datetime({ error: 'Field "createdAt" must be an ISO-8601 timestamp' }),
  text: z.string().nullable(),
}) satisfies z.ZodType<SessionMessage>;

export const sessionMessageListSchema = z.array(sessionMessageSchema) satisfies z.ZodType<
  SessionMessageList
>;

/** POST /api/sessions/{id}/messages body — text mirrors the v2 prompt's
 * only required payload field; projectId is the gate uuid (strict, Q2). */
export const sendMessageRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  text: z.string({ error: 'Field "text" is required' }).min(1),
}) satisfies z.ZodType<SendMessageRequest>;

/** SSE frame envelope of GET /api/sessions/events — the variant payload
 * (data) is upstream-owned and passes through as an unknown record;
 * `session` is the backend-hoisted data.sessionID (no upstream name at the
 * top level). Narrowed per-type frames (delta/updated) live in sessions.ts. */
export const sessionStreamFrameSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  type: z.string({ error: 'Field "type" is required' }).min(1),
  data: z.record(z.string(), z.unknown()),
  session: z.string().optional(),
}) satisfies z.ZodType<SessionStreamFrame>;

export type SendMessageInput = z.infer<typeof sendMessageRequestSchema>;
