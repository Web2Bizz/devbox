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
 * Auth-only path prefixes — nested org/project URLs (sidebar only in project).
 * `/projects` + `/secrets` + `/ai-providers` + `/registry*` + `/npm` are
 * legacy globals (410 Gone + CTA, see gone pages) — kept here so guests
 * still bounce to /login instead of rendering the gone shell.
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
 * - `/`: authed → `/organizations`, guest → `/login` (no bounce via `/login`).
 * - unauth + authed → `/organizations`; auth + guest → `/login`.
 * - public → `null` (unchanged).
 *
 * Loop-freedom: `/login` never redirects a guest, `/organizations` never
 * redirects an authed user, and the two destinations are fixed points
 * (`resolveAuthRedirect('/login', false) === null`,
 * `resolveAuthRedirect('/organizations', true) === null`).
 */
export function resolveAuthRedirect(pathname: string, authed: boolean): '/login' | '/organizations' | null {
  if (pathname === '/') return authed ? '/organizations' : '/login';
  if (isUnauthPath(pathname)) return authed ? '/organizations' : null;
  if (isAuthPath(pathname)) return authed ? null : '/login';
  return null;
}

/** Legacy global project path → nested CTA (no orgId → /organizations, never first-org fallback). */
export function legacyProjectRedirect(): '/organizations' {
  return '/organizations';
}
