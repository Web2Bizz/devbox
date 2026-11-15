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
 * GET /api/v1/sessions/providers — project-scoped provider inventory.
 * `projectId` nullish maps to the shared `'none'` scope so hooks without
 * a project share one stable cache entry (`??`, empty string stays as-is)
 * — same convention as the other session keys.
 */
export const aiProvidersQueryKey = (projectId?: string) =>
  ['ai-providers', projectId ?? 'none'] as const;

/**
 * GET /api/v1/sessions — project-scoped domain session list.
 * `projectId` nullish maps to the shared `'none'` scope so hooks without
 * a project share one stable empty entry (`??`, empty string stays as-is).
 */
export const sessionsQueryKey = (projectId?: string) =>
  ['sessions', projectId ?? 'none'] as const;

/** GET /api/v1/sessions/status — derived busy/idle map, same scope rule. */
export const sessionStatusQueryKey = (projectId?: string) =>
  ['sessions', 'status', projectId ?? 'none'] as const;

export const sessionModelsQueryKey = (projectId?: string) =>
  ['sessions', 'models', projectId ?? 'none'] as const;

/**
 * GET /api/v1/agents — agent registry (project-independent: the registry is
 * global, so the key carries no project scope — one shared cache entry).
 */
export const agentsQueryKey = ['agents'] as const;

/**
 * GET /api/v1/sessions/{id}/messages — project-scoped session thread.
 * `sessionId`/`projectId` nulls map to stable `'none'` scopes (same
 * convention as above — one entry per real scope, never one per render).
 */
export const sessionMessagesQueryKey = (sessionId: string | null, projectId?: string) =>
  ['session-messages', sessionId ?? 'none', projectId ?? 'none'] as const;

/**
 * GET /api/v1/sessions/{id}/snapshots/diff — two captured trees of a
 * session. The key carries the snapshot pair (a diff is a pure function of
 * it), never the file contents.
 */
export const sessionSnapshotDiffQueryKey = (
  sessionId: string | null,
  from: string | null,
  to: string | null,
) => ['session-snapshot-diff', sessionId ?? 'none', from ?? 'none', to ?? 'none'] as const;

/**
 * GET /api/v1/runs — project-scoped run list. `projectId` nullish maps to the
 * shared `'none'` scope (same convention as the session keys).
 */
export const runsQueryKey = (projectId?: string) => ['runs', projectId ?? 'none'] as const;

/** GET /api/v1/runs/{id} — one run row. */
export const runQueryKey = (runId: string | null) => ['runs', 'run', runId ?? 'none'] as const;
