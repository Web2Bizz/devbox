import { z } from 'zod';

import type { Project, ProjectStatus } from './project';

/**
 * Boundary schemas for project.ts.
 * Backend-verbatim: same regexes, min/max + error strings, partial-update
 * derivation. Response schema mirrors contracts/openapi.yaml Project.
 * 1:1 model: orgId required on create, immutable after create; scope and
 * link/unlink removed (M2M dropped).
 */

export const projectScopeSchema = z.enum(['user', 'org']);
export const projectStatusSchema = z.enum(['active', 'deleted']) satisfies z.ZodType<ProjectStatus>;

const ownerSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/, { error: 'githubOwner has invalid format' })
  .max(100);
const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/, { error: 'githubRepo has invalid format' })
  .max(100);
const branchSchema = z
  .string()
  .regex(/^[A-Za-z0-9_./-]+$/, { error: 'githubBranch has invalid format' })
  .max(100);

export const createProjectSchema = z.object({
  orgId: z.uuid({ error: 'Field "orgId" is required' }),
  name: z.string({ error: 'Field "name" is required' }).min(1).max(200),
  description: z.string().max(2000).optional(),
  githubOwner: ownerSchema.optional(),
  githubRepo: repoSchema.optional(),
  githubBranch: branchSchema.optional(),
  githubUrl: z.string().max(500).optional(),
  ownerId: z.string().max(200).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.partial();

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const githubLinkSchema = z.object({
  owner: ownerSchema,
  repo: repoSchema,
  branch: branchSchema.optional().default('main'),
});

export type GithubLinkInput = z.infer<typeof githubLinkSchema>;

export const projectSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  githubOwner: z.string().nullable(),
  githubRepo: z.string().nullable(),
  githubBranch: z.string().nullable(),
  githubUrl: z.string().nullable(),
  ownerId: z.string().nullable(),
  status: projectStatusSchema,
  deletedAt: z.string().nullable(),
  /** ISO-8601 timestamp */
  createdAt: z.string().min(1),
  /** ISO-8601 timestamp */
  updatedAt: z.string().min(1),
  corrupted: z.boolean(),
  corruptedReason: z.string().nullable(),
}) satisfies z.ZodType<Project>;

/** Effective config entry: project value overrides org value (backend merge). */
export const effectiveConfigEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  origin: z.enum(['project', 'organization']),
  overridden: z.boolean(),
});

export type EffectiveConfigEntry = z.infer<typeof effectiveConfigEntrySchema>;
