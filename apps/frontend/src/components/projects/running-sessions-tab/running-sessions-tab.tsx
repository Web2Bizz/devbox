'use client';

import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SessionInfo } from '@rush-code/contracts';
import {
  Badge,
  Button,
  Separator,
} from '@web2bizz/ui/components';
import { EmptyState, ErrorState, LoadingState } from '../../states';
import { useSessionEvents } from '../../../hooks/useSessionEvents';
import { useSessions } from '../../../hooks/useSessions';
import { useI18n } from '../../../i18n';

function streamColor(status: string) {
  if (status === 'live') return 'success' as const;
  if (status === 'error') return 'destructive' as const;
  return 'warning' as const;
}

/**
 * Running tab for /projects/[id] — busy sessions only.
 *
 * Data is the domain surface (see useSessions): the list + the derived
 * busy/idle `statusMap` from GET /api/v1/sessions/status (a working source —
 * the old runner status surface was never served by the current runtime,
 * which made the filter permanently empty). Liveness comes from
 * useSessionEvents (domain SSE, backoff 1s→15s, project-scoped), which
 * triggers a list+status reload on `session.*` frames; between frames the
 * rows' own derived status overlays the (possibly stale) map.
 * Abort is best-effort via useSessions → the domain interrupt route
 * (POST /api/v1/sessions/{id}/interrupt; idle answers interrupted=false).
 * Navigation/props: `projectId` required — no `?directory=`.
 *
 * List: linear ul/li + Separator (DESIGN §6, no Card), scroll owned by
 * the list container (max-h dvh + overflow-y-auto, overscroll-contain),
 * rows virtualized with @tanstack/react-virtual (pinned ESM, React 19).
 */

function RunningSessionRow({
  s,
  aborting,
  showSeparator,
  rowDisabled = false,
  onAbort,
}: {
  s: SessionInfo;
  aborting: boolean;
  showSeparator: boolean;
  rowDisabled?: boolean;
  onAbort: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {s.title || (s.id ? s.id.slice(0, 8) : t.sessions.untitled)}
          </p>
          {s.id ? (
            <code className="font-mono text-[0.85em] break-all text-muted-foreground text-xs">{s.id}</code>
          ) : null}
        </div>
        <Badge color="success" variant="soft">
          {t.sessions.live}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onAbort}
          disabled={aborting || rowDisabled}
        >
          {aborting ? t.common.loading : t.sessions.stop}
        </Button>
      </div>
      {showSeparator && <Separator className="mt-3" />}
    </div>
  );
}

export function RunningSessionsTab({
  projectId,
  disabled = false,
}: {
  projectId: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { sessions, statusMap, loading, error, reload, abort, abortingId } = useSessions({
    projectId,
  });
  const { events, status, reconnect } = useSessionEvents(projectId);
  const parentRef = useRef<HTMLDivElement>(null);

  // Live `session.*` frames trigger a list+status reload (the transient
  // retry state exists in the event stream only, never in the map).
  const lastType = events.length > 0 ? events[events.length - 1].type : '';
  useEffect(() => {
    if (lastType.startsWith('session.')) reload();
  }, [events.length]);

  // Busy filter: the derived status map, overlaid by the row's own status
  // while the map query has no entry yet (same server-computed source).
  const running = sessions.filter((s) => {
    const st = statusMap[s.id] ?? s.status;
    return st.type === 'busy' || st.type === 'retry';
  });

  const statusLabel =
    status === 'live'
      ? t.sessions.live
      : status === 'connecting'
        ? t.sessions.connecting
        : status === 'reconnecting'
          ? t.sessions.reconnecting
          : t.sessions.error;

  const virtualizer = useVirtualizer({
    count: running.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 10,
    getItemKey: (index) => running[index]?.id ?? index,
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <code className="font-mono text-[0.85em] break-all text-muted-foreground text-xs">projectId: {projectId}</code>
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={streamColor(status)} variant="soft">
            {statusLabel}
          </Badge>
          {status !== 'live' && (
            <Button variant="outline" size="sm" onClick={reconnect} disabled={disabled}>
              {t.sessions.reconnect}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={reload} disabled={disabled}>
            {t.common.refresh}
          </Button>
        </div>

        {loading && <LoadingState rows={2} />}

        {!loading && error && <ErrorState message={error} onRetry={reload} />}

        {!loading && !error && running.length === 0 && (
          <EmptyState
            title={t.sessions.runningTitle}
            description={t.sessions.emptyRunning}
          />
        )}

        {!loading && !error && running.length > 0 && (
          <div
            ref={parentRef}
            className="overflow-y-auto overscroll-contain"
            style={{ maxHeight: 'var(--sessions-list-max-h, 60dvh)' }}
          >
            <ul
              className="grid"
              style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const s = running[virtualRow.index];
                if (!s) return null;
                const aborting = abortingId === s.id;
                return (
                  <li
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <RunningSessionRow
                      s={s}
                      aborting={aborting}
                      showSeparator={virtualRow.index < running.length - 1}
                      rowDisabled={disabled}
                      onAbort={() => void abort(s.id)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
