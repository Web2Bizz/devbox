'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@web2bizz/ui/components';
import { ChatInput } from '@/components/chat/chat-input';
import { ChatWindow } from '@/components/chat/chat-window';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { useChat } from '@/hooks/useChat';
import { useProject } from '@/hooks/useProject';
import { useI18n } from '@/i18n';

/**
 * Route: /projects/[id]/sessions/[sessionId] — session = chat.
 *
 * Scoped chat bound to an existing opencode session:
 * `useProject(id)` guards the project (loading/error/notFound via
 * states.tsx), `useChat({ sessionId, projectId })` loads history via
 * `session.messages` (same mapping as reload), sends/prompts into that
 * session directly (no create), SSE deltas filtered by the active
 * sessionId (backoff 1s→15s), stop aborts prompt + server abort.
 *
 * Linear layout (DESIGN §6 — no Card wrappers): h1 + h2 header,
 * ChatWindow thread (autoscroll, streaming cursor, states.tsx),
 * ChatInput composer (Enter=send, Stop while streaming).
 * force-dynamic is inherited from app/(dashboard)/layout.tsx —
 * no generateStaticParams here (client-only useParams must render
 * on demand).
 */
export default function ProjectSessionChatPage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const rawId = params?.id;
  const rawSessionId = params?.sessionId;
  const id = Array.isArray(rawId) ? rawId[0] : (rawId as string | undefined);
  const sessionIdParam = Array.isArray(rawSessionId)
    ? rawSessionId[0]
    : (rawSessionId as string | undefined);

  const {
    project,
    loading: projectLoading,
    error: projectError,
    notFound,
    reload: reloadProject,
  } = useProject(id);
  const {
    messages,
    streamingText,
    loading: chatLoading,
    sending,
    error: chatError,
    send,
    stop,
    reload: reloadChat,
  } = useChat({ sessionId: sessionIdParam, projectId: id });

  const crumbs =
    project && !projectLoading
      ? [
          { label: t.nav.projects, href: '/projects' as const },
          { label: project.name, href: `/projects/${project.id}` as const },
          { label: (sessionIdParam ?? '').slice(0, 8), href: undefined },
        ]
      : [{ label: t.nav.projects, href: '/projects' as const }];

  if (projectLoading) {
    return (
      <div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t.chat.sessionTitle}</h1>
            <h2 className="text-muted-foreground text-sm font-normal">
              {t.chat.sessionSubtitle}
            </h2>
          </div>
          <Button variant="outline" size="sm" onClick={reloadProject} disabled>
            {t.common.loading}
          </Button>
        </div>
        <LoadingState rows={3} />
      </div>
    );
  }

  if (notFound) {
    return (
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
          description={projectError ?? t.projects.notFoundDesc}
          actionLabel={t.projects.back}
          onAction={() => router.push('/projects')}
        />
      </div>
    );
  }

  if (projectError) {
    return (
      <div>
        <div className="mb-4">
          <Link
            href="/projects"
            className="text-muted-foreground text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            ← {t.projects.back}
          </Link>
        </div>
        <ErrorState message={projectError} onRetry={reloadProject} />
      </div>
    );
  }

  if (!project) {
    return (
      <div>
        <div className="mb-4">
          <Link
            href="/projects"
            className="text-muted-foreground text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            ← {t.projects.back}
          </Link>
        </div>
        <ErrorState message={t.errors.unexpected} onRetry={reloadProject} />
      </div>
    );
  }

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

      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t.chat.sessionTitle}</h1>
          <h2 className="text-muted-foreground text-sm font-normal">
            {t.chat.sessionSubtitle}
          </h2>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={reloadChat}
          disabled={chatLoading && !chatError}
        >
          {chatLoading ? t.common.loading : t.common.refresh}
        </Button>
      </div>

      <div className="mb-3 grid gap-1">
        <code className="mono text-muted-foreground text-xs">projectId: {project.id}</code>
        <code className="mono text-muted-foreground text-xs">
          sessionId: {sessionIdParam}
        </code>
      </div>

      <div className="grid gap-4">
        <ChatWindow
          messages={messages}
          streamingText={streamingText}
          loading={chatLoading}
          sending={sending}
          error={chatError}
          onRetry={reloadChat}
        />
        <ChatInput onSend={(text) => void send(text)} onStop={stop} sending={sending} />
      </div>
    </div>
  );
}
