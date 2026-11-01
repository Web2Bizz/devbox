import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

/** Scope owner id segment: users/<uuid> or orgs/<uuid> (no slashes, no traversal). */
export const userSpaceSchema = z
  .string()
  .min(1, { error: 'userSpace must be a non-empty [a-zA-Z0-9_-] segment' })
  .max(64, { error: 'userSpace must be at most 64 chars' })
  .regex(/^[a-zA-Z0-9_-]+$/, {
    error: 'userSpace must match /^[a-zA-Z0-9_-]+$/',
  });

const numericQuery = (def: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .default(def)
    .transform((v) => Number(v));

export const reposQuerySchema = z.object({
  limit: numericQuery(50).refine((n) => Number.isInteger(n) && n >= 1 && n <= 100, {
    error: 'limit must be an integer 1-100',
  }),
  offset: numericQuery(0).refine((n) => Number.isInteger(n) && n >= 0, {
    error: 'offset must be a non-negative integer',
  }),
  q: z.string().max(100).optional().default(''),
});

export type ReposQuery = z.infer<typeof reposQuerySchema>;

export class RepoDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  userSpace!: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174001' })
  name!: string;

  /** Repo path relative to REPOS_ROOT, e.g. "users/<uuid>/projects/<uuid>/content". */
  @ApiProperty({ example: 'users/123e4567-e89b-12d3-a456-426614174000/projects/123e4567-e89b-12d3-a456-426614174001/content' })
  path!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
