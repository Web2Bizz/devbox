import type { ReactNode } from 'react';
import { DashboardShell } from '@/components/dashboard-shell';

/**
 * Project shell layout: sidebar only inside a project.
 * SidebarNav gets project-scoped items; org switcher carries orgId.
 * data-shell="dashboard" (guard matrix: project = auth shell).
 */
export const dynamic = 'force-dynamic';

export default async function ProjectShellLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string; projectId: string }>;
}) {
  const { orgId, projectId } = await params;
  const base = `/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
  const items = [
    { href: base, label: 'Overview' },
    { href: `${base}/sessions`, label: 'Sessions' },
    { href: `${base}/secrets`, label: 'Secrets' },
    { href: `${base}/ai-providers`, label: 'AI Providers' },
    { href: `${base}/registry`, label: 'Registry' },
  ];
  return (
    <DashboardShell sidebarItems={items}>
      <div data-shell="dashboard" data-project-shell={`${orgId}/${projectId}`}>
        {children}
      </div>
    </DashboardShell>
  );
}
