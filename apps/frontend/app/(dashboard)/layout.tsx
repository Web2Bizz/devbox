import type { ReactNode } from 'react';
import { DashboardShell } from '../../src/components/dashboard-shell';

/**
 * Route-group layout: flat URLs (/projects, /secrets, …) wrapped in the shell.
 * force-dynamic: pages use client-only Kit blocks (AlertDialog/Switch) +
 * usePathname shell — skip static prerender, render on demand.
 */
export const dynamic = 'force-dynamic';

export default function DashboardGroupLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
