'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@web2bizz/ui/components';
import { toast } from '@web2bizz/ui/widgets';
import { ChatRowSkeleton } from '../../states';
import { useSessions } from '../../../hooks/useSessions';
import { projectSessionPath } from '../../../lib/navigation';
import { SidebarNav, useSidebarClose } from '../../layout/Sidebar';
import { type Dictionary, type Locale, useI18n } from '../../../i18n';
import type { SessionListProps, SessionsSidebarProps } from './types';

/**
 * Sidebar panel of the project shell.
 *
 * On session routes (`/organizations/[orgId]/projects/[projectId]/sessions`
 * and `…/sessions/[sessionId]`) the sidebar stops being project navigation
 * and becomes the CHAT LIST — the chats belong next to the conversation,
 * not in the content block (product decision). Every other project route
 * keeps the plain `SidebarNav`. The switch happens client-side off
 * `usePathname()` because the shell layout is a server component and must
 * not know about the active segment.
 */

/** Thresholds mirror the mobile `formatTime` helper (same copy buckets). */
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

/**
 * Relative time for the meta line: just now → N minutes → N hours →
 * N days → absolute locale date (same buckets as the mobile list).
 * `null` only for an unparsable ISO value — nothing invented then.
 */
function formatRelativeTime(
  iso: string,
  locale: Locale,
  labels: Dictionary['sessions']['time'],
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const diff = Date.now() - date.getTime();
  if (diff < MINUTE) return labels.justNow;
  if (diff < HOUR) return labels.minutesAgo(Math.floor(diff / MINUTE));
  if (diff < DAY) return labels.hoursAgo(Math.floor(diff / HOUR));
  if (diff < WEEK) return labels.daysAgo(Math.floor(diff / DAY));
  return date.toLocaleDateString(locale);
}

export function SessionsSidebar({
  orgId,
  projectId,
  items,
}: SessionsSidebarProps) {
  const pathname = usePathname() ?? '';
  const sessionsBase = `/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/sessions`;
  const onSessionsRoute =
    pathname === sessionsBase || pathname.startsWith(`${sessionsBase}/`);
  const currentSessionId = pathname.startsWith(`${sessionsBase}/`)
    ? decodeURIComponent(pathname.slice(sessionsBase.length + 1).split('/')[0] ?? '')
    : undefined;

  if (!onSessionsRoute) return <SidebarNav items={items} />;

  return (
    <SessionList
      orgId={orgId}
      projectId={projectId}
      currentSessionId={currentSessionId || undefined}
    />
  );
}

/**
 * Chat list for the sidebar: a flat list of session links (no
 * virtualization — the aside owns the scroll) plus the create action.
 *
 * Row = session data card WITHOUT borders (DESIGN §7 «карточка данных»,
 * DESIGN §4.1 no border/shadow/gradient): a `bg-muted` surface distinguishes
 * the row from the sidebar surface; the active chat swaps to the solid
 * `--muted` (== `--sidebar-accent`) and gets `aria-current="page"`.
 * Radius step: aside is `--radius-xl` → row `rounded-md` (--radius-md) →
 * kit button owns its own.
 *
 * Navigation uses Next `Link` (prefetch + real href) and closes the mobile
 * drawer through `useSidebarClose()`; `aria-label` carries the accessible
 * name while the visible line stays the session title.
 */
export function SessionList({
  orgId,
  projectId,
  currentSessionId,
}: SessionListProps) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const closeSidebar = useSidebarClose();
  const {
    sessions,
    loading,
    error,
    reload,
    create,
    creating,
    abort,
    abortingId,
  } = useSessions({ projectId });

  const handleCreate = async () => {
    const created = await create();
    if (!created) return;
    closeSidebar?.();
    router.push(projectSessionPath(orgId, projectId, created.id));
  };

  // Toast-only errors (kit sonner): list failures surface as a top-right
  // toast with Retry (invalidateQueries via `reload`); the dialog/list stays
  // open so nothing is lost.
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!error) {
      lastErrorRef.current = null;
      return;
    }
    if (lastErrorRef.current === error) return;
    lastErrorRef.current = error;
    toast.error(t.errors.somethingWentWrong, {
      id: `sessions-list:${error}`,
      description: error,
      duration: 5500,
      action: { label: t.common.retry, onClick: reload },
    });
  }, [error, reload, t]);

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {t.sessions.chatsTitle}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void handleCreate()}
          disabled={creating}
        >
          {creating ? t.common.loading : t.sessions.create}
        </Button>
      </div>

      {loading && (
        <ul aria-busy="true" className="flex w-full min-w-0 list-none flex-col gap-1.5 m-0 p-0">
          {Array.from({ length: 3 }).map((_, index) => (
            <li key={index} className="w-full min-w-0">
              <ChatRowSkeleton />
            </li>
          ))}
        </ul>
      )}

      {!loading && sessions.length === 0 && (
        <p className="text-muted-foreground text-xs">{t.sessions.emptyAll}</p>
      )}

      {!loading && sessions.length > 0 && (
        <ul className="flex w-full min-w-0 list-none flex-col gap-1.5 m-0 p-0">
          {sessions.map((session) => {
            const title = session.title?.trim() || t.sessions.untitled;
            const time = formatRelativeTime(session.updatedAt, locale, t.sessions.time);
            const current = session.id === currentSessionId;
            const canAbort = session.status.type === 'busy' || session.status.type === 'retry';
            return (
              <li key={session.id} className="w-full min-w-0">
                <div className="flex w-full min-w-0 items-center gap-1">
                  <Link
                    href={projectSessionPath(orgId, projectId, session.id)}
                    onClick={closeSidebar}
                    aria-current={current ? 'page' : undefined}
                    aria-label={t.sessions.openSession(title)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-left no-underline transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sidebar-ring,var(--ring))] aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-semibold">{title}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                        {time ? (
                          <time dateTime={session.updatedAt} className="shrink-0">
                            {time}
                          </time>
                        ) : null}
                        {session.model ? (
                          <>
                            {time ? <span aria-hidden="true">·</span> : null}
                            <code className="truncate font-mono text-[0.95em]">
                              {session.model.id}
                            </code>
                          </>
                        ) : null}
                      </span>
                    </span>
                  </Link>
                  {canAbort && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => void abort(session.id)}
                      disabled={abortingId === session.id}
                    >
                      {abortingId === session.id ? t.common.loading : t.sessions.abort}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
