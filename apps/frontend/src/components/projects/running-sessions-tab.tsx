'use client';

import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Badge,
  Button,
  Separator,
} from '@web2bizz/ui/components';
import type { Session, SessionStatus } from '@opencode-ai/sdk/client';
import { opencode, toErrorMessage } from '../../api/opencode-client';
import { EmptyState, ErrorState, LoadingState } from '../states';
import { useOpencodeEvents } from '../../hooks/useOpencodeEvents';
import { useOpencodeSessions } from '../../hooks/useOpencodeSessions';
import { useI18n } from '../../i18n';

function streamColor(status: string) {
  if (status === 'live') return 'success' as const;
  if (status === 'error') return 'destructive' as const;
  return 'warning' as const;
}

/**
 * Running tab for /projects/[id] — busy sessions only.
 *
 * Reuses useOpencodeSessions list + abort; liveness comes from
 * useOpencodeEvents (SSE backoff 1s→15s) which triggers a list reload on
 * session.* frames, plus a one-shot `session.status()` map for the
 * busy/retry filter. `directory` is forwarded as `?directory=` to both the
 * list and the status map (same contract as SessionsTab).
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
  s: Session;
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
            {s.title || s.id.slice(0, 8)}
          </p>
          <code className="mono text-muted-foreground text-xs">{s.id}</code>
        </div>
        <Badge color="success" variant="soft">
          {t.opencode.live}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onAbort}
          disabled={aborting || rowDisabled}
        >
          {aborting ? t.common.loading : t.opencode.stop}
        </Button>
      </div>
      {showSeparator && <Separator className="mt-3" />}
    </div>
  );
}

export function RunningSessionsTab({
  projectId,
  directory,
  disabled = false,
}: {
  projectId: string;
  directory?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { sessions, loading, error, reload, abort, abortingId } = useOpencodeSessions(directory);
  const { events, status, reconnect } = useOpencodeEvents();
  const [statusMap, setStatusMap] = useState<Record<string, SessionStatus>>({});
  const [statusError, setStatusError] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    opencode.session
      .status(directory ? { query: { directory }, signal: ctrl.signal } : { signal: ctrl.signal })
      .then((res) => {
        if (cancelled) return;
        if (res.error !== undefined || res.data === undefined) {
          setStatusError(toErrorMessage(res.error));
          return;
        }
        setStatusMap(res.data as Record<string, SessionStatus>);
        setStatusError(null);
      })
      .catch((e: unknown) => {
        if (cancelled || (e as Error)?.name === 'AbortError') return;
        setStatusError(toErrorMessage(e));
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [directory]);

  // SSE session.* frames trigger a list reload; the busy/retry filter reads
  // the status map (server-scoped via `?directory=` when set).
  const lastType =
    events.length > 0 ? (events[events.length - 1] as { type?: string }).type ?? '' : '';
  useEffect(() => {
    if (lastType.startsWith('session.')) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  // Busy/retry filter from the status map (Rush Code projectId → opencode
  // directory mapping lands server-side later; `directory` scopes both).
  const running = sessions.filter((s) => {
    const st = statusMap[s.id];
    return st?.type === 'busy' || (st as { type?: string })?.type === 'retry';
  });

  const statusLabel =
    status === 'live'
      ? t.opencode.live
      : status === 'connecting'
        ? t.opencode.connecting
        : status === 'reconnecting'
          ? t.opencode.reconnecting
          : t.opencode.error;

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
        <code className="mono text-muted-foreground text-xs">projectId: {projectId}</code>
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={streamColor(status)} variant="soft">
            {statusLabel}
          </Badge>
          {status !== 'live' && (
            <Button variant="outline" size="sm" onClick={reconnect} disabled={disabled}>
              {t.opencode.reconnect}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={reload} disabled={disabled}>
            {t.common.refresh}
          </Button>
        </div>

        {loading && <LoadingState rows={2} />}

        {!loading && (error ?? statusError) && (
          <ErrorState message={(error ?? statusError) as string} onRetry={reload} />
        )}

        {!loading && !error && !statusError && running.length === 0 && (
          <EmptyState
            title={t.opencode.runningTitle}
            description={t.opencode.emptyRunning}
          />
        )}

        {!loading && !error && !statusError && running.length > 0 && (
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
