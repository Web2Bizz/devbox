import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

/** Scope owner id segment: orgs/<uuid> (no slashes, no traversal). */
export const userSpaceSchema: z.ZodString = z
  .string()
  .min(1, { error: 'userSpace must be a non-empty [a-zA-Z0-9_-] segment' })
  .max(64, { error: 'userSpace must be at most 64 chars' })
  .regex(/^[a-zA-Z0-9_-]+$/, {
    error: 'userSpace must match /^[a-zA-Z0-9_-]+$/',
  });

const numericQuery: (defaultValue: number) => z.ZodType<number> = (defaultValue: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .default(defaultValue)
    .transform((value) => Number(value));

export type ReposQuery = {
  limit: number;
  offset: number;
  q: string;
};

export const reposQuerySchema: z.ZodType<ReposQuery> = z.object({
  limit: numericQuery(50).refine((value) => Number.isInteger(value) && value >= 1 && value <= 100, {
    error: 'limit must be an integer 1-100',
  }),
  offset: numericQuery(0).refine((value) => Number.isInteger(value) && value >= 0, {
    error: 'offset must be a non-negative integer',
  }),
  q: z.string().max(100).optional().default(''),
});

export class RepoDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  userSpace!: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174001' })
  name!: string;

  /** Repo path relative to REPOS_ROOT, e.g. "orgs/<uuid>/projects/<uuid>/content". */
  @ApiProperty({ example: 'orgs/123e4567-e89b-12d3-a456-426614174000/projects/123e4567-e89b-12d3-a456-426614174001/content' })
  path!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
