import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { DashboardShell } from '@/components/dashboard-shell';
import { AUTH_MARKER, AUTH_MARKER_VALUE } from '@/lib/route-guard';

/**
 * Route-group layout: flat URLs (/projects, /secrets, …) wrapped in the shell.
 * force-dynamic: pages use client-only Kit blocks (AlertDialog/Switch) +
 * usePathname shell — skip static prerender, render on demand.
 *
 * Server guard (defense-in-depth behind edge `proxy.ts`): no readable
 * session marker → direct hits / RSC renders bounce to `/login` instead of
 * rendering the shell. Same `devbox-auth=1` contract, no token access.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardGroupLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  if (store.get(AUTH_MARKER)?.value !== AUTH_MARKER_VALUE) redirect('/login');
  return <DashboardShell>{children}</DashboardShell>;
}
