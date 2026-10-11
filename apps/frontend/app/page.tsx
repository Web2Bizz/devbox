import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Route: / → server redirect to /login (no middleware, no showcase).
 * force-dynamic: redirect() must run per-request (307) instead of a
 * static meta-refresh prerender.
 */
export default function RootPage() {
  redirect('/login');
}