import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';
import type { CloneJob } from './modules/clone/clone-jobs.repository';
import { REPO_URL_ALLOWED_FORMS_MESSAGE } from './modules/clone/utils/repo-url';

/** Repo dir name inside a user workspace: no slashes, no traversal. */
export const workspaceRepoSchema: z.ZodString = z
  .string()
  .min(1, { error: 'repo must be a non-empty [a-zA-Z0-9._-] segment' })
  .max(100, { error: 'repo must be at most 100 chars' })
  .regex(/^[a-zA-Z0-9._-]+$/, {
    error: 'repo must match /^[a-zA-Z0-9._-]+$/',
  })
  .refine((value) => value !== '.' && value !== '..', {
    error: 'repo must not be . or ..',
  });

/** Mirrors the service-side hostile-input guards (backslash, control chars, encoded separators). */
const REPO_URL_FORBIDDEN: RegExp = /[\\\u0000-\u001f\u007f]|%2e|%2f/i;

/**
 * Allowed shapes: https://… (no userinfo), ssh://git@host/… and
 * git@host:path. file:/http:/local paths are rejected here.
 */
function isAllowedRepoUrlForm(value: string): boolean {
  const url: string = value.trim();
  if (/^https:\/\/\S+$/.test(url)) return !/^https:\/\/[^/]*@/.test(url);
  if (/^ssh:\/\/\S+$/.test(url)) {
    return /^ssh:\/\/git@[A-Za-z0-9.-]+(?::\d+)?\/\S+$/.test(url);
  }
  return /^git@[A-Za-z0-9.-]+:\S+$/.test(url);
}

/**
 * Clone source — https://, ssh:// and git@host:path only. The service applies
 * the authoritative host allow-list; this boundary rejects the shapes that
 * can never be cloned. Never logged verbatim (AppLogger masks URL credentials).
 */
export const workspaceRepoUrlSchema: z.ZodString = z
  .string()
  .min(1, { error: 'repoUrl must be non-empty' })
  .max(2048, { error: 'repoUrl must be at most 2048 chars' })
  .refine(isAllowedRepoUrlForm, {
    error: REPO_URL_ALLOWED_FORMS_MESSAGE,
  })
  .refine((value) => !REPO_URL_FORBIDDEN.test(value), {
    error: REPO_URL_ALLOWED_FORMS_MESSAGE,
  });

export type CloneWorkspaceInput = {
  repoUrl: string;
  repoName: string;
  installationId?: number;
};

export const cloneWorkspaceSchema: z.ZodType<CloneWorkspaceInput> = z.object({
  repoUrl: workspaceRepoUrlSchema,
  repoName: workspaceRepoSchema,
  installationId: z.number().int().positive().optional(),
});

const numericQuery: (defaultValue: number) => z.ZodType<number> = (defaultValue: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .default(defaultValue)
    .transform((value) => Number(value));

export type WorkspaceTreeQuery = {
  path: string;
  depth: number;
};

export const workspaceTreeQuerySchema: z.ZodType<WorkspaceTreeQuery> = z.object({
  path: z.string().max(1024).optional().default('.'),
  depth: numericQuery(1).refine((value) => Number.isInteger(value) && value >= 0 && value <= 5, {
    error: 'depth must be an integer 0-5',
  }),
});

export type CloneStatusInput = Pick<CloneJob, 'status' | 'progress' | 'error'>;

export const cloneStatusSchema: z.ZodType<CloneStatusInput> = z.object({
  status: z.enum(['queued', 'cloning', 'ready', 'failed']),
  progress: z.number().int().min(0).max(100),
  error: z.string().nullable(),
});

export class CloneWorkspaceDto {
  @ApiProperty({
    example: 'https://github.com/acme/demo.git',
    description:
      'Clone source: https://…, ssh://git@host/… or git@host:path (exact-host allow-list).',
  })
  repoUrl!: string;

  @ApiProperty({ example: 'demo' })
  repoName!: string;

  @ApiProperty({ required: false, example: 789012 })
  installationId?: number;
}

export class WorkspaceCloneJobDto {
  @ApiProperty({ example: 'alice' })
  userSpace!: string;

  @ApiProperty({ example: 'demo' })
  repoName!: string;

  @ApiProperty({ enum: ['queued', 'cloning', 'ready', 'failed'] })
  status!: string;

  @ApiProperty({ example: 100 })
  progress!: number;

  @ApiProperty({ nullable: true, example: null })
  error!: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class WorkspaceTreeNodeDto {
  @ApiProperty({ example: 'README.md' })
  path!: string;

  @ApiProperty({ enum: ['file', 'dir'] })
  type!: string;

  @ApiProperty({ required: false, type: [WorkspaceTreeNodeDto] })
  children?: Array<WorkspaceTreeNodeDto>;
}

export class WorkspaceSubmoduleDto {
  @ApiProperty({ example: 'libs/shared' })
  path!: string;

  @ApiProperty({ example: 'https://github.com/acme/shared.git' })
  url!: string | null;

  @ApiProperty({ example: 'abc1234' })
  sha!: string | null;

  @ApiProperty({ example: ' ' })
  status!: string;
}
