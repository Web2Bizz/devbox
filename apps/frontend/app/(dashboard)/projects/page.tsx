'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@web2bizz/ui/components';
import { EmptyState, ErrorState, LoadingState } from '../../../src/components/states';
import { CreateProjectDialog } from '../../../src/components/projects/create-project-dialog';
import { useProjects } from '../../../src/hooks/useProjects';
import { useI18n } from '../../../src/i18n';
import type { ProjectStatus } from '../../../src/lib/types';

function statusColor(status: ProjectStatus) {
  if (status === 'active') return 'success' as const;
  if (status === 'draft') return 'warning' as const;
  return 'muted' as const;
}

/**
 * Route: /projects — production grid of project Cards.
 * Data comes from `useProjects` (`GET /api/v1/projects` via ApiClient);
 * empty/error/loading are handled by the hook, create via `CreateProjectDialog`.
 */
export default function ProjectsPage() {
  const { t } = useI18n();
  const { projects, loading, error, isEmpty, reload, createProject, creating, createError } =
    useProjects();
  const [open, setOpen] = useState(false);
  const [createdOk, setCreatedOk] = useState<string | null>(null);

  const handleCreate = useCallback(
    async (name: string) => {
      try {
        const created = await createProject(name);
        setCreatedOk(created.name);
        setTimeout(() => setCreatedOk(null), 2500);
      } catch {
        // validation/network error is surfaced via createError from the hook
      }
    },
    [createProject],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {t.projects.titleA} <span className="text-gradient-brand">{t.projects.titleB}</span>
          </h1>
        </div>
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
              <Button variant="primaryBrand" size="sm">
                {t.projects.createTrigger}
              </Button>
            }
          />
        </div>
      </div>

      {createdOk && (
        <Alert className="mb-4">
          <AlertTitle>{createdOk}</AlertTitle>
          <AlertDescription>✓ {t.projects.create.submit} — {createdOk}</AlertDescription>
        </Alert>
      )}
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
        <div className="status-grid">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              aria-label={`${p.name} — ${p.status}`}
              className="block h-full rounded-[var(--radius-lg)] focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <Card variant={p.status === 'active' ? 'brand' : 'default'} className="h-full">
                <CardHeader>
                  <CardTitle>{p.name}</CardTitle>
                  <CardDescription>{p.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2">
                  <Badge color={statusColor(p.status)} variant="soft">
                    {p.status}
                  </Badge>
                  {p.corrupted && (
                    <Badge color="destructive" variant="soft">
                      {t.projects.brokenBadge}
                    </Badge>
                  )}
                  {p.repo && (
                    <code className="mono text-muted-foreground text-xs">{p.repo}</code>
                  )}
                </CardContent>
                <CardFooter>
                  <p className="text-muted-foreground text-xs">
                    {t.projects.updatedPrefix} {new Date(p.updatedAt).toLocaleDateString()}
                  </p>
                </CardFooter>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
