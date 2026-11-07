import { z } from 'zod';

import type {
  AgentInfo,
  AgentInfoList,
  CreateSessionRequest,
  InterruptSessionRequest,
  RevertInfo,
  RevertStageRequest,
  SendMessageRequest,
  SessionForkBoundary,
  SessionForkRequest,
  SessionForkResponse,
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
  SessionStreamErrorFrame,
  SessionStreamFrame,
  SnapshotDiff,
  SnapshotDiffList,
  ToolCallInfo,
} from './sessions';
import { opencodeSessionStatusSchema } from '../opencode-session/opencode-session.schema';

/**
 * Boundary schemas for sessions.ts (domain /api/v1/sessions* contract).
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
  /** ISO-8601 last activity (message append / binding change) — same
   * strictness as createdAt: backend-emitted, never an upstream passthrough. */
  updatedAt: z.iso.datetime({ error: 'Field "updatedAt" must be an ISO-8601 timestamp' }),
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

/** POST /api/v1/sessions body — projectId required (sessions are project-scoped). */
export const createSessionRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  title: z.string().min(1).max(200).optional(),
  parentID: z.string().min(1).max(200).optional(),
  model: sessionInfoModelSchema.optional(),
  agentId: agentIdSchema.optional(),
}) satisfies z.ZodType<CreateSessionRequest>;

export type CreateSessionInput = z.infer<typeof createSessionRequestSchema>;

/** GET /api/v1/sessions/{id}/messages item — normalized Session.Message.Info
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

/** POST /api/v1/sessions/{id}/messages body — text mirrors the v2 prompt's
 * only required payload field; projectId is the gate uuid (strict, Q2). */
export const sendMessageRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  text: z.string({ error: 'Field "text" is required' }).min(1),
  model: sessionInfoModelSchema.optional(),
  agentId: agentIdSchema.optional(),
}) satisfies z.ZodType<SendMessageRequest>;

/** SSE frame envelope of GET /api/v1/sessions/events — the variant payload
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

/** stream.error — terminal transport frame (C0). Narrow and optional:
 * the envelope schema stays permissive (`type: string`), this schema lets
 * consumers detect the terminal channel before the text tract. `data` is
 * intentionally loose (message/code only) — never secrets. */
export const sessionStreamErrorFrameSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  type: z.literal('stream.error'),
  data: z.object({
    message: z.string().optional(),
    code: z.string().optional(),
  }).catchall(z.unknown()),
  session: z.string().optional(),
}) satisfies z.ZodType<SessionStreamErrorFrame>;

/** POST /api/v1/sessions/{id}/interrupt body — projectId is the gate uuid
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

/**
 * POST /api/v1/sessions/{id}/fork body — projectId is the gate uuid (strict,
 * same rule as create/send): backend-generated, never runtime passthrough.
 * `before` is the boundary message id; omitted → the whole thread is forked.
 */
export const sessionForkRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  before: z.string().min(1).max(200).optional(),
}) satisfies z.ZodType<SessionForkRequest>;

/** Fork boundary — 'through' includes the message, 'before' excludes it. */
export const sessionForkBoundarySchema = z.object({
  type: z.enum(['before', 'through'], {
    error: 'Field "type" must be one of before|through',
  }),
  messageID: z.string({ error: 'Field "messageID" is required' }).min(1),
}) satisfies z.ZodType<SessionForkBoundary>;

/** POST /api/v1/sessions/{id}/fork answer — the created session + its copy boundary. */
export const sessionForkResponseSchema = z.object({
  session: sessionInfoSchema,
  boundary: sessionForkBoundarySchema,
}) satisfies z.ZodType<SessionForkResponse>;

/** One per-file snapshot diff (hunks absent for a name-only comparison). */
export const snapshotDiffSchema = z.object({
  file: z.string({ error: 'Field "file" is required' }).min(1),
  hunks: z.string().optional(),
}) satisfies z.ZodType<SnapshotDiff>;

export const snapshotDiffListSchema = z.array(snapshotDiffSchema) satisfies z.ZodType<
  SnapshotDiffList
>;

/** POST /api/v1/sessions/{id}/revert/stage body — boundary message + optional path filter. */
export const revertStageRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  messageID: z.string({ error: 'Field "messageID" is required' }).min(1).max(200),
  files: z.array(z.string().min(1)).optional(),
}) satisfies z.ZodType<RevertStageRequest>;

/** Staged revert answer — boundary, source snapshot (nullable) and file diffs. */
export const revertInfoSchema = z.object({
  messageID: z.string({ error: 'Field "messageID" is required' }).min(1),
  snapshot: z.string().nullable(),
  files: z.array(snapshotDiffSchema),
}) satisfies z.ZodType<RevertInfo>;

/** Tool-call timeline row (call id, registry name, optional namespace, result text). */
export const toolCallInfoSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  name: z.string({ error: 'Field "name" is required' }).min(1),
  namespace: z.string().optional(),
  result: z.string({ error: 'Field "result" is required' }),
}) satisfies z.ZodType<ToolCallInfo>;

export type SessionForkInput = z.infer<typeof sessionForkRequestSchema>;
export type RevertStageInput = z.infer<typeof revertStageRequestSchema>;
