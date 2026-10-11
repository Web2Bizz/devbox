import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route guard — readable marker cookie only (`devbox-auth=1`, set by the
 * backend on login/register/refresh, cleared on logout). Carries no secret;
 * real authorization stays server-side (JwtAuthGuard). Unauthenticated
 * dashboard routes → /login; authenticated /login → /projects.
 */
const PROTECTED_PREFIXES = [
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
];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const authed = req.cookies.get('devbox-auth')?.value === '1';
  const protected_ = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (protected_ && !authed) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  if (pathname === '/login' && authed) {
    const url = req.nextUrl.clone();
    url.pathname = '/projects';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/projects/:path*', '/organizations/:path*', '/users/:path*', '/profile/:path*', '/secrets/:path*', '/ai-providers/:path*', '/chat/:path*', '/registry/:path*', '/registries/:path*', '/npm/:path*', '/login'],
};
