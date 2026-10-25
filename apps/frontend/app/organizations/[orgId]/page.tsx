'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@web2bizz/ui/components';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { useOrganization } from '@/hooks/useOrganization';
import { useOrgProjects } from '@/hooks/useOrgProjects';
import { useI18n } from '@/i18n';

/**
 * Route: /organizations/[orgId] — plain screen (no sidebar).
 * Org overview + nested project list + create (orgId forced).
 */
export default function OrganizationPlainDetailPage() {
  const { t } = useI18n();
  const params = useParams();
  const raw = params?.orgId;
  const orgId = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  const { organization, loading: orgLoading, error: orgError } = useOrganization(orgId);
  const { projects, loading, error, isEmpty, reload } = useOrgProjects(orgId);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10" data-shell="plain">
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
        <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
          {loading ? t.common.loading : t.common.refresh}
        </Button>
      </div>

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
    </main>
  );
}
