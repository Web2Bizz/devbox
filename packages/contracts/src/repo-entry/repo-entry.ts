/**
 * Readonly git-repo registry entry.
 *
 * Mirrors contracts/openapi.yaml components/schemas Repo (field-for-field)
 * plus apps/backend/src/contracts.ts RepoEntry.
 * Previously duplicated in apps/backend/src/contracts.ts and
 * apps/frontend/src/api/types.ts — this package is the single source.
 */

/** GET /api/v1/repos + GET /api/v1/repos/:userSpace — readonly git-repo registry */
export type RepoEntry = {
  userSpace: string;
  name: string;
  /** Path relative to REPOS_ROOT, e.g. "alice/workspace/demo" */
  path: string;
  /** ISO-8601 mtime of the repo directory */
  updatedAt: string;
};
