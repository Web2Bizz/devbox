import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

/** Repo dir name inside a user workspace: no slashes, no traversal. */
export const workspaceRepoSchema = z
  .string()
  .min(1, { error: 'repo must be a non-empty [a-zA-Z0-9._-] segment' })
  .max(100, { error: 'repo must be at most 100 chars' })
  .regex(/^[a-zA-Z0-9._-]+$/, {
    error: 'repo must match /^[a-zA-Z0-9._-]+$/',
  })
  .refine((s) => s !== '.' && s !== '..', {
    error: 'repo must not be . or ..',
  });

/**
 * Clone source — https:/git@/ssh:/file: URLs plus absolute local paths
 * (local paths exist only for offline fixtures/tests; production uses URLs).
 * Never logged verbatim (AppLogger masks URL credentials).
 */
export const workspaceRepoUrlSchema = z
  .string()
  .min(1, { error: 'repoUrl must be non-empty' })
  .max(2048, { error: 'repoUrl must be at most 2048 chars' })
  .refine((s) => !s.includes('\0'), {
    error: 'repoUrl must not contain null bytes',
  })
  .refine(
    (s) =>
      /^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(s.trim()),
    {
      error:
        'repoUrl must be https://, git@, ssh://, file:// or an absolute local path',
    },
  );

export const cloneWorkspaceSchema = z.object({
  repoUrl: workspaceRepoUrlSchema,
  repoName: workspaceRepoSchema,
  installationId: z.number().int().positive().optional(),
});

export type CloneWorkspaceInput = z.infer<typeof cloneWorkspaceSchema>;

const numericQuery = (def: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .default(def)
    .transform((v) => Number(v));

export const workspaceTreeQuerySchema = z.object({
  path: z.string().max(1024).optional().default('.'),
  depth: numericQuery(1).refine((n) => Number.isInteger(n) && n >= 0 && n <= 5, {
    error: 'depth must be an integer 0-5',
  }),
});

export type WorkspaceTreeQuery = z.infer<typeof workspaceTreeQuerySchema>;

export const cloneStatusSchema = z.object({
  status: z.enum(['queued', 'cloning', 'ready', 'failed']),
  progress: z.number().int().min(0).max(100),
  error: z.string().nullable(),
});

export class CloneWorkspaceDto {
  @ApiProperty({ example: 'https://github.com/acme/demo.git' })
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
  children?: WorkspaceTreeNodeDto[];
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
