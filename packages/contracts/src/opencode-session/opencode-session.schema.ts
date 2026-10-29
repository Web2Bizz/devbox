import { z } from 'zod';

import type {
  OpencodeFileDiff,
  OpencodeLocationRef,
  OpencodePermissionRule,
  OpencodeSession,
  OpencodeSessionFork,
  OpencodeSessionForkBoundary,
  OpencodeSessionModelRef,
  OpencodeSessionRevert,
  OpencodeSessionStatus,
  OpencodeSessionStatusAction,
  OpencodeSessionTime,
  OpencodeSessionTokens,
} from './opencode-session';

/**
 * Boundary schemas for opencode-session.ts — the read side of the
 * /api/opencode/* mirror (upstream Session.Info passthrough).
 *
 * Upstream-owned shapes: objects are NOT locked down (unknown keys pass
 * through zod default stripping, never rejected) so a forward-compatible
 * server field cannot break a client parse; required/optional sets mirror
 * the live 2.2.0 spec exactly (required: id, projectID, cost, tokens, time,
 * location — a fresh session carries no title, verified by live probe).
 * Discriminated where the wire is discriminated (status.type,
 * fork.boundary.type, outcome, permission effect, file diff status).
 */

export const opencodeLocationRefSchema = z.object({
  directory: z.string({ error: 'Field "location.directory" is required' }).min(1),
}) satisfies z.ZodType<OpencodeLocationRef>;

export const opencodeSessionModelRefSchema = z.object({
  id: z.string({ error: 'Field "model.id" is required' }).min(1),
  providerID: z.string({ error: 'Field "model.providerID" is required' }).min(1),
  variant: z.string().optional(),
}) satisfies z.ZodType<OpencodeSessionModelRef>;

export const opencodeSessionTokensSchema = z.object({
  input: z.number({ error: 'Field "tokens.input" is required' }),
  output: z.number({ error: 'Field "tokens.output" is required' }),
  reasoning: z.number({ error: 'Field "tokens.reasoning" is required' }),
  cache: z.object({
    read: z.number({ error: 'Field "tokens.cache.read" is required' }),
    write: z.number({ error: 'Field "tokens.cache.write" is required' }),
  }),
}) satisfies z.ZodType<OpencodeSessionTokens>;

export const opencodeSessionTimeSchema = z.object({
  created: z.number({ error: 'Field "time.created" is required' }),
  updated: z.number({ error: 'Field "time.updated" is required' }),
  idle: z.number().optional(),
  viewed: z.number().optional(),
  archived: z.number().optional(),
}) satisfies z.ZodType<OpencodeSessionTime>;

export const opencodePermissionRuleSchema = z.object({
  action: z.string({ error: 'Field "permissions[].action" is required' }).min(1),
  resource: z.string({ error: 'Field "permissions[].resource" is required' }).min(1),
  effect: z.enum(['allow', 'deny', 'ask'], {
    error: 'Field "permissions[].effect" is required',
  }),
}) satisfies z.ZodType<OpencodePermissionRule>;

export const opencodeSessionForkBoundarySchema = z.object({
  type: z.enum(['before', 'through'], { error: 'Field "fork.boundary.type" is required' }),
  messageID: z.string({ error: 'Field "fork.boundary.messageID" is required' }).min(1),
}) satisfies z.ZodType<OpencodeSessionForkBoundary>;

export const opencodeSessionForkSchema = z.object({
  sessionID: z.string({ error: 'Field "fork.sessionID" is required' }).min(1),
  boundary: opencodeSessionForkBoundarySchema,
}) satisfies z.ZodType<OpencodeSessionFork>;

export const opencodeFileDiffSchema = z.object({
  file: z.string({ error: 'Field "revert.files[].file" is required' }).min(1),
  patch: z.string({ error: 'Field "revert.files[].patch" is required' }),
  additions: z.number({ error: 'Field "revert.files[].additions" is required' }).int().min(0),
  deletions: z.number({ error: 'Field "revert.files[].deletions" is required' }).int().min(0),
  status: z.enum(['added', 'deleted', 'modified'], {
    error: 'Field "revert.files[].status" is required',
  }),
  // upstream narrows `more` to the literal true (pagination marker)
  more: z.literal(true).optional(),
}) satisfies z.ZodType<OpencodeFileDiff>;

export const opencodeSessionRevertSchema = z.object({
  messageID: z.string({ error: 'Field "revert.messageID" is required' }).min(1),
  partID: z.string().optional(),
  snapshot: z.string().optional(),
  files: z.array(opencodeFileDiffSchema).optional(),
}) satisfies z.ZodType<OpencodeSessionRevert>;

export const opencodeSessionSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  parentID: z.string().optional(),
  projectID: z.string({ error: 'Field "projectID" is required' }).min(1),
  agent: z.string().optional(),
  model: opencodeSessionModelRefSchema.optional(),
  cost: z.number({ error: 'Field "cost" is required' }),
  tokens: opencodeSessionTokensSchema,
  outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(),
  time: opencodeSessionTimeSchema,
  title: z.string().optional(),
  subpath: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  permissions: z.array(opencodePermissionRuleSchema).optional(),
  fork: opencodeSessionForkSchema.optional(),
  revert: opencodeSessionRevertSchema.optional(),
  location: opencodeLocationRefSchema,
}) satisfies z.ZodType<OpencodeSession>;

export const opencodeSessionListSchema = z.array(opencodeSessionSchema);

export const opencodeSessionStatusActionSchema = z.object({
  reason: z.string({ error: 'Field "status.action.reason" is required' }).min(1),
  provider: z.string({ error: 'Field "status.action.provider" is required' }).min(1),
  title: z.string({ error: 'Field "status.action.title" is required' }).min(1),
  message: z.string({ error: 'Field "status.action.message" is required' }),
  label: z.string({ error: 'Field "status.action.label" is required' }).min(1),
  link: z.string().optional(),
}) satisfies z.ZodType<OpencodeSessionStatusAction>;

export const opencodeSessionStatusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('busy') }),
  z.object({
    type: z.literal('retry'),
    attempt: z.number({ error: 'Field "status.attempt" is required' }).int().min(1),
    message: z.string({ error: 'Field "status.message" is required' }),
    next: z.number({ error: 'Field "status.next" is required' }),
    action: opencodeSessionStatusActionSchema.optional(),
  }),
]) satisfies z.ZodType<OpencodeSessionStatus>;

export const opencodeSessionStatusMapSchema = z.record(z.string(), opencodeSessionStatusSchema);
