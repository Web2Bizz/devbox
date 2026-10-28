'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Badge } from '@web2bizz/ui/components';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { useProject } from '@/hooks/useProject';
import { api } from '@/api/client';
import { getValidAccessToken } from '@/lib/auth-store';
import { useI18n } from '@/i18n';

type Entry = { key: string; value: string; origin: 'project' | 'organization'; overridden: boolean };

/**
 * Route: /organizations/[orgId]/projects/[projectId] — project overview.
 * Effective config shown as value + origin/overridden (merge is backend-only).
 */
export default function NestedProjectPage() {
  const { t } = useI18n();
  const params = useParams();
  const pick = (k: string) => {
    const v = params?.[k];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  };
  const orgId = pick('orgId');
  const projectId = pick('projectId');
  const { project, loading, error, notFound } = useProject(orgId, projectId);
  const [effective, setEffective] = useState<Entry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!orgId || !projectId) return;
    void getValidAccessToken().then((token) => {
      if (!token || cancelled) return;
      void api
        .getEffectiveConfig(token, orgId, projectId)
        .then((rows) => {
          if (!cancelled) setEffective(rows);
        })
        .catch(() => {
          if (!cancelled) setEffective([]);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, projectId]);

  if (loading) return <LoadingState rows={3} />;
  if (notFound)
    return <EmptyState title={t.projects.notFoundTitle} description={error ?? t.projects.notFoundDesc} />;
  if (error) return <ErrorState message={error} />;
  if (!project) return <EmptyState title={t.projects.notFoundTitle} description={t.projects.notFoundDesc} />;

  return (
    <div className="grid gap-4">
      {project.corrupted && (
        <Alert variant="destructive">
          <AlertTitle>{t.projects.brokenTitle}</AlertTitle>
          <AlertDescription>{t.projects.brokenDesc}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <p className="text-sm">{project.description}</p>
        <Badge color="muted" variant="soft" className="w-fit">
          {project.status}
        </Badge>
      </div>
      <div className="grid gap-2">
        <h2 className="text-lg font-semibold">Effective config</h2>
        {effective === null && <LoadingState rows={1} />}
        {effective !== null && effective.length === 0 && (
          <p className="text-muted-foreground text-sm">No org/project overrides yet.</p>
        )}
        {effective !== null && effective.length > 0 && (
          <ul className="grid gap-1">
            {effective.map((e) => (
              <li key={e.key} className="text-sm">
                <code className="font-mono text-xs">{e.key}</code> — {e.origin}
                {e.overridden ? ' (overridden)' : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
