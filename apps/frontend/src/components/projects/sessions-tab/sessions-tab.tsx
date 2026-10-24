'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Badge,
  Button,
  Separator,
} from '@web2bizz/ui/components';
import type { Session } from '@opencode-ai/sdk/client';
import { EmptyState, ErrorState, LoadingState } from '../../states';
import { useOpencodeSessions } from '../../../hooks/useOpencodeSessions';
import { useI18n } from '../../../i18n';

/**
 * Sessions tab for /projects/[id] — full session list scoped to a project.
 *
 * Data: useOpencodeSessions list/create/abort through the backend
 * reverse-proxy (`/api/opencode`, sdk 1.18.33). `directory` (opencode
 * working directory) is forwarded as `?directory=`; omit it for the full
 * list. Rush Code `projectId` (prj-*) stays UI-only until the backend maps
 * project id → directory server-side, but it scopes navigation:
 * Open (and post-create) routes to the session chat at
 * `/projects/[id]/sessions/[sessionId]` (session = chat).
 *
 * List: linear ul/li + Separator (DESIGN §6, no Card), scroll owned by
 * the list container (max-h dvh + overflow-y-auto, overscroll-contain)
 * so .app-content never scrolls for 100+ rows. Rows are virtualized
 * with @tanstack/react-virtual (pinned ESM, React 19, Turbopack).
 */

function SessionRow({
  s,
  opened,
  aborting,
  showSeparator,
  rowDisabled = false,
  onOpen,
  onToggleDetails,
  onAbort,
}: {
  s: Session;
  opened: boolean;
  aborting: boolean;
  showSeparator: boolean;
  rowDisabled?: boolean;
  onOpen: () => void;
  onToggleDetails: () => void;
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
        <Badge color="info" variant="soft">
          {new Date(s.time.updated).toLocaleString()}
        </Badge>
      </div>
      {opened && (
        <div className="grid gap-1">
          <code className="mono text-muted-foreground text-xs">
            projectID: {s.projectID}
          </code>
          <code className="mono text-muted-foreground text-xs">
            directory: {s.directory}
          </code>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onOpen}
          disabled={rowDisabled}
        >
          {t.opencode.open}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onToggleDetails}
          aria-expanded={opened}
        >
          {opened ? t.common.hide : t.common.reveal}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onAbort}
          disabled={aborting || rowDisabled}
        >
          {aborting ? t.common.loading : t.opencode.abort}
        </Button>
      </div>
      {showSeparator && <Separator className="mt-3" />}
    </div>
  );
}

export function SessionsTab({
  projectId,
  directory,
  disabled = false,
}: {
  projectId: string;
  directory?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const {
    sessions,
    loading,
    error,
    reload,
    create,
    creating,
    abort,
    abortingId,
  } = useOpencodeSessions(directory);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  // Server-side scoping via `?directory=` (see useOpencodeSessions); without
  // a directory the backend returns the full list.
  const visible = sessions;

  const openSessionChat = (sessionId: string) => {
    router.push(`/projects/${projectId}/sessions/${sessionId}`);
  };

  const handleCreateAndOpen = async () => {
    const created = await create();
    if (created) openSessionChat(created.id);
  };

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140,
    overscan: 10,
    getItemKey: (index) => visible[index]?.id ?? index,
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <code className="mono text-muted-foreground text-xs">projectId: {projectId}</code>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => void handleCreateAndOpen()}
            disabled={creating || disabled}
          >
            {creating ? t.common.loading : t.opencode.create}
          </Button>
          <Button variant="outline" size="sm" onClick={reload} disabled={disabled}>
            {t.common.refresh}
          </Button>
        </div>

        {loading && <LoadingState rows={2} />}

        {!loading && error && <ErrorState message={error} onRetry={reload} />}

        {!loading && !error && visible.length === 0 && (
          <EmptyState
            title={t.opencode.sessionsTitle}
            description={t.opencode.emptyAll}
            {...(disabled
              ? {}
              : {
                  actionLabel: t.opencode.create,
                  onAction: () => void handleCreateAndOpen(),
                })}
          />
        )}

        {!loading && !error && visible.length > 0 && (
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
                const s = visible[virtualRow.index];
                if (!s) return null;
                const opened = openedId === s.id;
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
                    <SessionRow
                      s={s}
                      opened={opened}
                      aborting={aborting}
                      showSeparator={virtualRow.index < visible.length - 1}
                      rowDisabled={disabled}
                      onOpen={() => openSessionChat(s.id)}
                      onToggleDetails={() => setOpenedId(opened ? null : s.id)}
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
