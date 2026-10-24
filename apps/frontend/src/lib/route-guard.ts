/**
 * Route-guard contract — single source of truth for auth routing.
 *
 * Routing classes (skills/routing):
 * - auth: authenticated-only (`app/(dashboard)/…`). Guest → `/login`.
 * - unauth: guests-only (`/login` + reserved `/register`, `/restore` —
 *   today login/register share one page with a mode switch; the reserved
 *   prefixes keep the matrix stable if split out later). Authed → `/projects`.
 * - public: everything else (`/`, assets, backend API) — untouched by guards.
 *
 * Readers of the guard (edge `proxy.ts`, server group layouts) decide from
 * the readable marker cookie `rush-code-auth=1` alone (set by the backend on
 * login/register/refresh, cleared on logout; client-duplicated in
 * `auth-store.ts` for cross-port dev). The marker carries no secret — real
 * authorization stays server-side (backend JwtAuthGuard); data hooks fail
 * closed on 401 independently.
 *
 * Pure module (no `next/*` imports) so `bun test` can cover the matrix
 * without a router.
 */

/** Readable session-marker cookie name (contract with backend + proxy). */
export const AUTH_MARKER = 'rush-code-auth';
/** Marker value meaning "a session exists". */
export const AUTH_MARKER_VALUE = '1';

/**
 * Auth-only path prefixes — flat URLs under `app/(dashboard)`.
 * `/registries` + `/npm` are legacy aliases (`next.config` redirects them to
 * `/registry/docker|npm` before guards run); listed so the matrix stays
 * closed if those redirects ever go away.
 */
export const AUTH_PREFIXES = [
  '/projects',
  '/organizations',
  '/users',
  '/profile',
  '/secrets',
  '/ai-providers',
  '/chat',
  '/registry',
  '/registries',
  '/npm',
] as const;

/** Guest-only (unauth) path prefixes. */
export const UNAUTH_PREFIXES = ['/login', '/register', '/restore'] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Auth-only path (guest must be bounced to `/login`). */
export function isAuthPath(pathname: string): boolean {
  return AUTH_PREFIXES.some((p) => matchesPrefix(pathname, p));
}

/** Guest-only path (authed user must be bounced to `/projects`). */
export function isUnauthPath(pathname: string): boolean {
  return UNAUTH_PREFIXES.some((p) => matchesPrefix(pathname, p));
}

/**
 * Redirect destination for (`pathname`, `authed`), or `null` to render.
 * - `/`: authed → `/projects`, guest → `/login` (no bounce via `/login`).
 * - unauth + authed → `/projects`; auth + guest → `/login`.
 * - public → `null` (unchanged).
 *
 * Loop-freedom: `/login` never redirects a guest, `/projects` never
 * redirects an authed user, and the two destinations are fixed points
 * (`resolveAuthRedirect('/login', false) === null`,
 * `resolveAuthRedirect('/projects', true) === null`).
 */
export function resolveAuthRedirect(pathname: string, authed: boolean): '/login' | '/projects' | null {
  if (pathname === '/') return authed ? '/projects' : '/login';
  if (isUnauthPath(pathname)) return authed ? '/projects' : null;
  if (isAuthPath(pathname)) return authed ? null : '/login';
  return null;
}
