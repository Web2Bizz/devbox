import { z } from 'zod';

import type {
  CreateSessionRequest,
  SessionInfo,
  SessionInfoList,
  SessionInfoModel,
  SessionRunStatus,
  SessionRunStatusMap,
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
  /** ISO-8601 */
  createdAt: z.string({ error: 'Field "createdAt" is required' }).min(1),
  directory: z.string({ error: 'Field "directory" is required' }).min(1),
  projectId: z.string({ error: 'Field "projectId" is required' }).min(1),
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
