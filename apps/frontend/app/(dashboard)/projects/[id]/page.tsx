'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@web2bizz/ui/components';
import {
  EmptyState,
  ErrorState,
  ProjectDetailSkeleton,
} from '../../../../src/components/states';
import { SessionsTab } from '../../../../src/components/projects/sessions-tab';
import { RunningSessionsTab } from '../../../../src/components/projects/running-sessions-tab';
import { useProject } from '../../../../src/hooks/useProject';
import { useI18n } from '../../../../src/i18n';

/**
 * Route: /projects/[id] — single project (live API via `useProject`).
 * force-dynamic is inherited from app/(dashboard)/layout.tsx —
 * no generateStaticParams here (client-only Kit blocks + useParams
 * must render on demand).
 */
export default function ProjectDetailPage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const raw = params?.id;
  const id = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  const { project, loading, error, notFound, reload } = useProject(id);

  const crumbs =
    project && !loading
      ? [
          { label: t.nav.projects, href: '/projects' as const },
          { label: project.name, href: undefined },
        ]
      : [{ label: t.nav.projects, href: '/projects' as const }];

  return (
    <div>
      <nav
        aria-label={t.nav.sections}
        className="text-muted-foreground mb-3 flex min-w-0 flex-wrap items-center gap-1 text-sm"
      >
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={`${crumb.label}-${i}`} className="flex items-center gap-1">
              {i > 0 && (
                <span aria-hidden="true" className="text-muted-foreground">
                  /
                </span>
              )}
              {crumb.href && !isLast ? (
                <Link href={crumb.href} className="hover:underline">
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
              )}
            </span>
          );
        })}
      </nav>

      {loading && <ProjectDetailSkeleton />}

      {!loading && notFound && (
        <div>
          <div className="mb-4">
            <Link
              href="/projects"
              className="text-muted-foreground text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              ← {t.projects.back}
            </Link>
          </div>
          <EmptyState
            title={t.projects.notFoundTitle}
            description={error ?? t.projects.notFoundDesc}
            actionLabel={t.projects.back}
            onAction={() => router.push('/projects')}
          />
        </div>
      )}

      {!loading && !notFound && error && (
        <div>
          <div className="mb-4">
            <Link
              href="/projects"
              className="text-muted-foreground text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              ← {t.projects.back}
            </Link>
          </div>
          <ErrorState message={error} />
        </div>
      )}

      {!loading && !error && !notFound && project && (
        <div className="grid gap-4">
          {project.corrupted && (
            <Alert variant="destructive">
              <AlertTitle>{t.projects.brokenTitle}</AlertTitle>
              <AlertDescription>
                {t.projects.brokenDesc}
                {project.corruptedReason && (
                  <span className="mt-1 block">
                    {t.projects.brokenReasonLabel}:{' '}
                    <code className="mono text-xs">{project.corruptedReason}</code>
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}
          {project.corrupted && (
            <Badge color="destructive" variant="soft" className="w-fit">
              {t.projects.brokenBadge}
            </Badge>
          )}
          <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">{t.projects.tabs.overview}</TabsTrigger>
            <TabsTrigger value="secrets">{t.projects.tabs.secrets}</TabsTrigger>
            <TabsTrigger value="ai">{t.projects.tabs.ai}</TabsTrigger>
            <TabsTrigger value="sessions" disabled={project.corrupted}>
              {t.projects.tabs.sessions}
            </TabsTrigger>
            <TabsTrigger value="running" disabled={project.corrupted}>
              {t.projects.tabs.running}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" id="overview">
            <div className="grid gap-2">
              <div className="grid gap-1">
                <h1 className="text-2xl font-semibold">{project.name}</h1>
                <h2 className="text-lg font-semibold">{t.projects.overviewTitle}</h2>
                <p className="text-muted-foreground text-sm">{t.projects.overviewDesc}</p>
              </div>
              <p className="text-sm">{project.description}</p>
              {project.repo && (
                <code className="mono text-muted-foreground text-xs">{project.repo}</code>
              )}
              <p className="text-muted-foreground text-xs">
                {t.projects.updatedPrefix} {new Date(project.updatedAt).toLocaleDateString()}
              </p>
            </div>
          </TabsContent>

            <TabsContent value="secrets" id="secrets">
              <div className="grid gap-3">
                <div className="grid gap-1">
                  <h2 className="text-lg font-semibold">{t.projects.secretsTitle}</h2>
                  <p className="text-muted-foreground text-sm">{t.projects.secretsDesc}</p>
                </div>
                <code className="mono text-muted-foreground text-xs">
                  projectId: {project.id}
                </code>
                <div>
                  {project.corrupted ? (
                    <span
                      aria-disabled="true"
                      className="text-muted-foreground text-sm"
                    >
                      {t.nav.secrets} →
                    </span>
                  ) : (
                    <Link
                      href="/secrets"
                      className="text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {t.nav.secrets} →
                    </Link>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="ai" id="ai">
              <div className="grid gap-3">
                <div className="grid gap-1">
                  <h2 className="text-lg font-semibold">{t.projects.aiTitle}</h2>
                  <p className="text-muted-foreground text-sm">{t.projects.aiDesc}</p>
                </div>
                <code className="mono text-muted-foreground text-xs">
                  projectId: {project.id}
                </code>
                <div>
                  {project.corrupted ? (
                    <span
                      aria-disabled="true"
                      className="text-muted-foreground text-sm"
                    >
                      {t.nav.aiProviders} →
                    </span>
                  ) : (
                    <Link
                      href="/ai-providers"
                      className="text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {t.nav.aiProviders} →
                    </Link>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="sessions" id="sessions">
              <SessionsTab projectId={project.id} disabled={project.corrupted} />
            </TabsContent>

            <TabsContent value="running" id="running">
              <RunningSessionsTab projectId={project.id} disabled={project.corrupted} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}
