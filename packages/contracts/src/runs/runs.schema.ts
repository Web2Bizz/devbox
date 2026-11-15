import { z } from 'zod';

import type {
  CreateRunRequest,
  RunInfo,
  RunInfoList,
  RunStatus,
  RunStepStatus,
  RunStepType,
  RunStreamFrame,
  ToolView,
} from './runs';
import { agentIdSchema, sessionInfoModelSchema } from '../sessions/sessions.schema';

/**
 * Boundary schemas for runs.ts (domain /api/v1/runs* contract).
 *
 * Response schemas mirror contracts/openapi.yaml and are for CLIENT-side
 * parsing — nullable title/sandboxId/agentId/model are explicit keys (never
 * optional: the server always answers them, null when unset).
 * createRunRequestSchema is the backend-verbatim POST validation (same
 * constraints + error strings the controller enforces).
 */

export const runStatusSchema = z.enum([
  'open',
  'running',
  'awaiting_human',
  'failed',
  'merged',
  'abandoned',
]) satisfies z.ZodType<RunStatus>;

export const runStepStatusSchema = z.enum([
  'pending',
  'running',
  'committed',
  'failed',
  'skipped',
]) satisfies z.ZodType<RunStepStatus>;

export const runStepTypeSchema = z.enum([
  'llm.call',
  'tool.call',
  'sandbox.exec',
  'git.commit',
  'await_human',
  'router',
]) satisfies z.ZodType<RunStepType>;

export const runInfoSchema = z.object({
  id: z.uuid({ error: 'Field "id" is required' }),
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  title: z.string().nullable(),
  status: runStatusSchema,
  /** pin of the active definition set the run was created with */
  definitionSetHash: z.string({ error: 'Field "definitionSetHash" is required' }).min(1),
  /** sha of the Forward-Only lower bound */
  baseCommit: z.string({ error: 'Field "baseCommit" is required' }).min(1),
  /** server-owned agent branch (agent/<run_id>) */
  branch: z.string({ error: 'Field "branch" is required' }).min(1),
  /** worktree path inside the REPOS_ROOT jail */
  worktree: z.string({ error: 'Field "worktree" is required' }).min(1),
  /** opencode-runner slot; null while the run owns none */
  sandboxId: z.string().nullable(),
  agentId: agentIdSchema.nullable(),
  model: sessionInfoModelSchema.nullable(),
  createdAt: z.iso.datetime({ error: 'Field "createdAt" must be an ISO-8601 timestamp' }),
  updatedAt: z.iso.datetime({ error: 'Field "updatedAt" must be an ISO-8601 timestamp' }),
}) satisfies z.ZodType<RunInfo>;

export const runInfoListSchema = z.array(runInfoSchema) satisfies z.ZodType<RunInfoList>;

/** POST /api/v1/runs body — projectId required (runs are project-scoped). */
export const createRunRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  title: z.string().min(1).max(200).optional(),
  agentId: agentIdSchema.optional(),
  model: sessionInfoModelSchema.optional(),
  /** omitted = the active definition set */
  definitionSetHash: z.string().min(1).optional(),
}) satisfies z.ZodType<CreateRunRequest>;

export type CreateRunInput = z.infer<typeof createRunRequestSchema>;

/** SSE frame envelope of GET /api/v1/runs/{id}/events — `id` is the per-run
 * monotonic seq as a string; `data` is the variant payload passed through as
 * an unknown record (envelope-only, matching SessionStreamFrame). */
export const runStreamFrameSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  type: z.enum(['run.started', 'run.step.started', 'run.step.committed', 'run.step.failed'], {
    error: 'Field "type" must be one of the prototype run frame types',
  }),
  data: z.record(z.string(), z.unknown()),
  run: z.string().optional(),
}) satisfies z.ZodType<RunStreamFrame>;

/** D3 model-facing tool projection — the id keeps its origin prefix
 * (mcp|skill|native) and a dotted native path such as native:git.recon. */
export const toolViewSchema = z.object({
  id: z
    .string({ error: 'Field "id" is required' })
    .min(1)
    .max(200)
    .regex(/^(mcp|skill|native):[a-z0-9._/-]+$/, {
      error: 'Field "id" must be a <mcp|skill|native>:<path> tool id',
    }),
  title: z.string({ error: 'Field "title" is required' }).min(1).max(200),
  description: z.string({ error: 'Field "description" is required' }).min(1).max(2000),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<ToolView>;
