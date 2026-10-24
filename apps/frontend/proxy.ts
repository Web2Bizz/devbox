import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_MARKER, AUTH_MARKER_VALUE, resolveAuthRedirect } from './src/lib/route-guard';

/**
 * Edge route guard (Next 16 `proxy` convention — `middleware.ts` is
 * deprecated since v16 and renamed to `proxy`: same file location, exported
 * function renamed `middleware` → `proxy`).
 *
 * Reads the readable marker cookie only (`rush-code-auth=1`, set by the
 * backend on login/register/refresh, cleared on logout). Carries no secret;
 * real authorization stays server-side (backend JwtAuthGuard).
 * - Guest on auth/root → `/login`; authed on unauth/root → `/projects`.
 * - public paths (assets, `_next/*`, backend API) never match → untouched.
 * Defense-in-depth partners: server guards in `app/(dashboard)/layout.tsx`
 * (guest → `/login`) and `app/(auth)/layout.tsx` (authed → `/projects`),
 * plus the client dead-session check in `DashboardShell`.
 */
export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const authed = req.cookies.get(AUTH_MARKER)?.value === AUTH_MARKER_VALUE;
  const destination = resolveAuthRedirect(pathname, authed);
  if (!destination) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = destination;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    '/',
    '/login/:path*',
    '/register/:path*',
    '/restore/:path*',
    '/projects/:path*',
    '/organizations/:path*',
    '/users/:path*',
    '/profile/:path*',
    '/secrets/:path*',
    '/ai-providers/:path*',
    '/chat/:path*',
    '/registry/:path*',
    '/registries/:path*',
    '/npm/:path*',
  ],
};
