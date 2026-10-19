/**
 * Centralized React Query keys — single source for cache identity.
 *
 * Cache contract (unchanged, lives in `lib/query-client.ts`):
 * - staleTime 30s, gcTime 5m, retry 1 with exponential backoff.
 * - `refetchOnWindowFocus: false`, `refetchOnReconnect: true`.
 * - Auth refresh contract unchanged: `getValidAccessToken()` inside
 *   `queryFn`, one silent `refreshAccessToken()` retry on 401, then
 *   the session-expired message (see `lib/auth-store.ts`).
 *
 * Hook rule (enforced by P1–P3 migrations, not by this module):
 * - `queryFn` throws the raw backend envelope on failure (never formats).
 * - `formatApiError(error) + t` mapping lives in `useMemo` outside `queryFn`.
 *
 * Reused keys below are re-exported (not duplicated) so P1–P3 can migrate
 * hook imports here without changing cache identity.
 */

export { PROJECTS_QUERY_KEY } from './useProjects';
export { ORGANIZATIONS_QUERY_KEY } from './useOrganizations';
export { projectQueryKey } from './useProject';
export { organizationQueryKey } from './useOrganization';
export { orgMembersQueryKey } from './useOrgMembers';
export { userQueryKey } from './useUser';

/** GET /api/v1/auth/me — header + profile identity. */
export const PROFILE_QUERY_KEY = ['profile'] as const;

/** GET /api/v1/usage — opencode quota/usage breakdown. */
export const USAGE_QUERY_KEY = ['usage'] as const;

/** GET /api/v1/registry/catalog — live Docker Registry catalog. */
export const REGISTRIES_QUERY_KEY = ['registries'] as const;

/** Live npm reachability probe (single-row status list). */
export const NPM_QUERY_KEY = ['npm', 'status'] as const;

/**
 * GET /api/opencode/config/providers — per-directory provider list.
 * Nullish directory maps to the shared `'all'` scope so the
 * default view has one stable cache entry (`??`, empty string stays as-is).
 */
export const aiProvidersQueryKey = (directory?: string) =>
  ['ai-providers', directory ?? 'all'] as const;
