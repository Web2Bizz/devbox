'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@web2bizz/ui/components';
import { ErrorState, LoadingState } from '../../states';
import { useSessions } from '../../../hooks/useSessions';
import { projectSessionPath } from '../../../lib/navigation';
import { SidebarNav, type SidebarNavItem, useSidebarClose } from '../../layout/Sidebar';
import { type Dictionary, type Locale, useI18n } from '../../../i18n';

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
}: {
  orgId: string;
  projectId: string;
  /** Project nav items — rendered on every non-session route. */
  items?: readonly SidebarNavItem[];
}) {
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
}: {
  orgId: string;
  projectId: string;
  currentSessionId?: string;
}) {
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

      {loading && <LoadingState rows={2} />}

      {!loading && error && <ErrorState message={error} onRetry={reload} />}

      {!loading && !error && sessions.length === 0 && (
        <p className="text-muted-foreground text-xs">{t.sessions.emptyAll}</p>
      )}

      {!loading && !error && sessions.length > 0 && (
        <ul className="flex w-full min-w-0 list-none flex-col gap-1.5 m-0 p-0">
          {sessions.map((s) => {
            const title = s.title?.trim() || t.sessions.untitled;
            const time = formatRelativeTime(s.createdAt, locale, t.sessions.time);
            const current = s.id === currentSessionId;
            const canAbort = s.status.type === 'busy' || s.status.type === 'retry';
            return (
              <li key={s.id} className="w-full min-w-0">
                <div className="flex w-full min-w-0 items-center gap-1">
                  <Link
                    href={projectSessionPath(orgId, projectId, s.id)}
                    onClick={closeSidebar}
                    aria-current={current ? 'page' : undefined}
                    aria-label={t.sessions.openSession(title)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-left no-underline transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sidebar-ring,var(--ring))] aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{title}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                        {time ? (
                          <time dateTime={s.createdAt} className="shrink-0">
                            {time}
                          </time>
                        ) : null}
                        {s.model ? (
                          <>
                            {time ? <span aria-hidden="true">·</span> : null}
                            <code className="truncate font-mono text-[0.95em]">
                              {s.model.id}
                            </code>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span aria-hidden="true" className="text-muted-foreground">
                      ›
                    </span>
                  </Link>
                  {canAbort && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => void abort(s.id)}
                      disabled={abortingId === s.id}
                    >
                      {abortingId === s.id ? t.common.loading : t.sessions.abort}
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
