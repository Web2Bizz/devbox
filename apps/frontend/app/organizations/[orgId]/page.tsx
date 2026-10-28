'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@web2bizz/ui/components';
import { DashboardShell } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { CreateProjectDialog } from '@/components/projects/create-project-dialog';
import { useOrganization } from '@/hooks/useOrganization';
import { useOrgProjects } from '@/hooks/useOrgProjects';
import { useI18n } from '@/i18n';

/**
 * Route: /organizations/[orgId] — org overview inside DashboardShell
 * (Header + Sidebar + Content, sidebarItems/breadcrumbs like ProjectShellLayout).
 * Org overview + nested project list + create (orgId forced).
 * data-shell="dashboard" (auth shell).
 */
export default function OrganizationDetailPage() {
  const { t } = useI18n();
  const params = useParams();
  const raw = params?.orgId;
  const orgId = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  const { organization, loading: orgLoading, error: orgError } = useOrganization(orgId);
  const { projects, loading, error, isEmpty, reload, createProject, creating, createError } = useOrgProjects(orgId);
  const [open, setOpen] = useState(false);
  const base = orgId ? `/organizations/${encodeURIComponent(orgId)}` : '/organizations';
  const handleCreate = useCallback(
    async (name: string) => {
      try {
        await createProject(name);
      } catch {
        // surfaced via createError
      }
    },
    [createProject],
  );
  const sidebarItems = orgId ? [{ href: base, label: 'Overview' }] : undefined;

  return (
    <DashboardShell
      sidebarItems={sidebarItems}
      header={{
        breadcrumbs: [
          { label: t.nav.organizations, href: '/organizations' },
          { label: organization?.name ?? orgId ?? '' },
        ],
        actions: (
          <Link href="/organizations" className="text-sm underline underline-offset-4">
            {t.orgs.back}
          </Link>
        ),
      }}
    >
      <div className="w-full max-w-none m-0 px-0 py-2" data-shell="dashboard">
      <nav aria-label={t.nav.sections} className="text-muted-foreground mb-3 flex items-center gap-1 text-sm">
        <Link href="/organizations" className="hover:underline">
          {t.nav.organizations}
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{organization?.name ?? orgId}</span>
      </nav>

      {orgLoading && <LoadingState rows={2} />}
      {orgError && !orgLoading && <ErrorState message={orgError} />}

      {organization && (
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">{organization.name}</h1>
          {organization.description && (
            <p className="text-muted-foreground text-sm">{organization.description}</p>
          )}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t.projects.titleA}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
            {loading ? t.common.loading : t.common.refresh}
          </Button>
          <CreateProjectDialog
            open={open}
            onOpenChange={setOpen}
            onCreate={handleCreate}
            creating={creating}
            trigger={
              <Button variant="primaryBrand" size="sm" aria-label={t.projects.createTrigger}>
                {t.projects.createTrigger}
              </Button>
            }
          />
        </div>
      </div>

      {createError && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>{t.errors.somethingWentWrong}</AlertTitle>
          <AlertDescription>{createError}</AlertDescription>
        </Alert>
      )}

      {loading && <LoadingState rows={3} />}
      {error && !loading && <ErrorState message={error} />}
      {isEmpty && <EmptyState title={t.projects.emptyTitle} description={t.projects.emptyDesc} />}

      {!loading && !error && !isEmpty && (
        <ul className="grid gap-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/organizations/${orgId}/projects/${p.id}`}
                className="underline underline-offset-4 text-sm"
              >
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <Link href="/organizations" className="text-muted-foreground text-sm hover:underline">
          ← {t.orgs.back}
        </Link>
      </div>
      </div>
    </DashboardShell>
  );
}
