import { z } from 'zod';

import type {
  AgentInfo,
  AgentInfoList,
  CreateSessionRequest,
  InterruptSessionRequest,
  SendMessageRequest,
  SessionInfo,
  SessionInfoList,
  SessionInfoModel,
  SessionModel,
  SessionInterruptResult,
  SessionMessage,
  SessionMessageList,
  SessionMessagePartDeltaFrame,
  SessionMessagePartUpdatedFrame,
  SessionRunnerProvider,
  SessionRunnerProviderList,
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

export const sessionModelSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  name: z.string({ error: 'Field "name" is required' }),
  providerID: z.string({ error: 'Field "providerID" is required' }).min(1),
}) satisfies z.ZodType<SessionModel>;

export const sessionModelListSchema = z.array(sessionModelSchema) satisfies z.ZodType<
  Array<SessionModel>
>;

/** Agent registry id — mirrors the backend agentIdPattern (letters/digits/_/-). */
export const agentIdSchema = z
  .string({ error: 'Field "agentId" is required' })
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    error: 'Field "agentId" has forbidden characters',
  });

export const agentInfoSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  name: z.string({ error: 'Field "name" is required' }),
  description: z.string({ error: 'Field "description" is required' }),
}) satisfies z.ZodType<AgentInfo>;

export const agentInfoListSchema = z.array(agentInfoSchema) satisfies z.ZodType<AgentInfoList>;

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
  agentId: agentIdSchema.nullable(),
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
  model: sessionInfoModelSchema.optional(),
  agentId: agentIdSchema.optional(),
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
  model: sessionInfoModelSchema.optional(),
  agentId: agentIdSchema.optional(),
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

/** message.part.delta — narrowed streaming-text frame. The field list is
 * the artifact eventFrames.usedVariants['message.part.delta'] verbatim
 * (sessionID/messageID/partID/field/delta, all strings) and REQUIRED by
 * this check: a frame missing any of them is not this variant (safeParse,
 * never a cast). Unknown extra keys inside data stay tolerated — the
 * runner may enrich the payload, and value-add must not break the chat. */
export const sessionMessagePartDeltaFrameSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  type: z.literal('message.part.delta'),
  data: z.object({
    sessionID: z.string({ error: 'Field "data.sessionID" is required' }).min(1),
    messageID: z.string({ error: 'Field "data.messageID" is required' }).min(1),
    partID: z.string({ error: 'Field "data.partID" is required' }).min(1),
    field: z.string({ error: 'Field "data.field" is required' }),
    delta: z.string({ error: 'Field "data.delta" is required' }),
  }),
  session: z.string().optional(),
}) satisfies z.ZodType<SessionMessagePartDeltaFrame>;

/** message.part.updated — narrowed absolute-part-snapshot frame. The field
 * list is the artifact eventFrames.usedVariants['message.part.updated']
 * verbatim (sessionID + part object); the part's inner keys (type/text/id)
 * are variant-owned content the envelope does not mirror, so consumers
 * still read them with typeof guards (see useSessionChat projections). */
export const sessionMessagePartUpdatedFrameSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  type: z.literal('message.part.updated'),
  data: z.object({
    sessionID: z.string({ error: 'Field "data.sessionID" is required' }).min(1),
    part: z.record(z.string(), z.unknown()),
  }),
  session: z.string().optional(),
}) satisfies z.ZodType<SessionMessagePartUpdatedFrame>;

/** POST /api/sessions/{id}/interrupt body — projectId is the gate uuid
 * (strict like the YAML format: uuid; backend-generated, Q2 precedent). */
export const interruptSessionRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
}) satisfies z.ZodType<InterruptSessionRequest>;

/** SessionInterruptResult — artifact SessionInterruptResponse is exactly
 * {interrupted: boolean} (additionalProperties:false); false is the idle
 * no-op, an honest answer rather than an error. */
export const sessionInterruptResultSchema = z.object({
  interrupted: z.boolean({ error: 'Field "interrupted" is required' }),
}) satisfies z.ZodType<SessionInterruptResult>;

/** SessionRunnerProvider — the REQUIRED subset of the artifact
 * Provider.Info (id/name/activation/package, enum values verbatim).
 * settings/headers/body stay upstream: headers may carry auth material
 * and the UI consumes none of them — never shipped to the browser. */
export const sessionRunnerProviderSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  name: z.string({ error: 'Field "name" is required' }),
  activation: z.enum(['auto', 'enabled', 'disabled'], {
    error: 'Field "activation" must be one of auto|enabled|disabled',
  }),
  package: z.string({ error: 'Field "package" is required' }),
}) satisfies z.ZodType<SessionRunnerProvider>;

export const sessionRunnerProviderListSchema = z.array(sessionRunnerProviderSchema) satisfies z.ZodType<
  SessionRunnerProviderList
>;

export type SendMessageInput = z.infer<typeof sendMessageRequestSchema>;

export type InterruptSessionInput = z.infer<typeof interruptSessionRequestSchema>;
