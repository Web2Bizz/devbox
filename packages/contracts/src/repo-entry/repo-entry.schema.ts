import { z } from 'zod';

import type { RepoEntry } from './repo-entry';

/**
 * Boundary schema for repo-entry.ts.
 * userSpace mirrors apps/backend/src/repos/dto.ts userSpaceSchema verbatim
 * (same length/charset constraints + error strings — the openapi path param
 * requires the same /^[a-zA-Z0-9_-]+$/ segment). Remaining scalars carry
 * min(1) so empty strings fail fast; no max/charset on name/path — the
 * registry lists hand-dropped dirs and must never reject live data.
 */

export const repoEntrySchema = z.object({
  userSpace: z
    .string()
    .min(1, { error: 'userSpace must be a non-empty [a-zA-Z0-9_-] segment' })
    .max(64, { error: 'userSpace must be at most 64 chars' })
    .regex(/^[a-zA-Z0-9_-]+$/, {
      error: 'userSpace must match /^[a-zA-Z0-9_-]+$/',
    }),
  name: z.string().min(1),
  /** Path relative to REPOS_ROOT, e.g. "alice/workspace/demo" */
  path: z.string().min(1),
  /** ISO-8601 mtime of the repo directory */
  updatedAt: z.string().min(1),
}) satisfies z.ZodType<RepoEntry>;
