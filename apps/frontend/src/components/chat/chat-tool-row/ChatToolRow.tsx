'use client';

import { useState } from 'react';
import { useI18n } from '../../../i18n';
import type { ChatEntry } from '../../../lib/chat-chain';
import {
  formatRawToolEventLine,
  formatToolEventStatus,
  formatToolEventTitle,
  isToolDetailExpandable,
  toolRowDotClass,
  toToolRowStatus,
  type ChatToolEvent,
  type ToolRowStatus,
} from '../chat-tool-timeline/types';
import type { ChatToolRowProps } from './types';

/** Unified chain entry → timeline event (thin render adapter, no new fields). */
function toToolEvent(entry: Extract<ChatEntry, { kind: 'tool' }>): ChatToolEvent {
  return {
    id: entry.id,
    at: entry.at,
    kind: entry.name === 'reasoning' ? 'reasoning' : 'tool',
    label: entry.name,
    ...(entry.detail ?? entry.status ? { detail: entry.detail ?? entry.status } : {}),
  };
}

/**
 * One tool/reasoning row of the flat chat chronology — Claude/Cursor-style.
 *
 * The thread is a single chronological list (`message`, `tool`, `tool`,
 * `message`, …), so a tool call is its own flat row in parentId order: a
 * status dot + mono tool name + human status word, with the real `detail`
 * payload behind an expander (phase keywords render as the status word
 * only — nothing invented, no fixture `args`/`result`).
 *
 * Entry-only: the unified `ChatEntry` tool row (durable REST + live SSE
 * share the same type, reload parity before/after) plus the live sidecar
 * `liveToolName` for the in-flight tool with no chain row yet (`running`,
 * `aria-busy`).
 *
 * Statuses are the domain vocabulary (`running`/`done`/`error` from
 * `session_messages` `status`/`detail` via `toToolRowStatus`), failed rows
 * start expanded. Flat content per DESIGN.md §7: no `Card`/`border`/
 * `background` wrapper — only a row, a `border-l` detail rail and kit
 * tokens (`text-muted-foreground`/`text-destructive`, `font-mono`).
 */
export function ChatToolRow({ entry, liveToolName }: ChatToolRowProps) {
  const { t } = useI18n();
  const resolvedEvent = entry && entry.kind === 'tool' ? toToolEvent(entry) : undefined;
  const domainStatus = entry && entry.kind === 'tool' ? entry.status : undefined;
  const rowStatus: ToolRowStatus = resolvedEvent
    ? toToolRowStatus(resolvedEvent.detail, domainStatus)
    : 'running';
  const expandable = resolvedEvent ? isToolDetailExpandable(resolvedEvent.detail) : false;
  const [expanded, setExpanded] = useState(rowStatus === 'error' && expandable);
  if (!resolvedEvent && !liveToolName) return null;

  if (!resolvedEvent) {
    return (
      <div
        data-testid="chat-tool-live"
        data-kind="tool"
        data-status="running"
        aria-busy="true"
        className="px-1 py-0.5"
      >
        <div className="flex min-w-0 items-center gap-2 py-1 text-sm">
          <span aria-hidden="true" className={`inline-block size-1.5 shrink-0 rounded-full ${toolRowDotClass('running')}`} />
          <span className="truncate font-mono text-xs">{liveToolName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{t.chat.toolProgress}</span>
        </div>
      </div>
    );
  }

  const kind = resolvedEvent.kind;
  const name = formatToolEventTitle(resolvedEvent, t);
  const statusWord = formatToolEventStatus(resolvedEvent, t);
  const detail = resolvedEvent.detail;

  return (
    <div
      data-testid="chat-tool-row"
      data-kind={kind}
      data-status={rowStatus}
      title={formatRawToolEventLine(resolvedEvent)}
      className="px-1 py-0.5"
    >
      <div className="flex min-w-0 items-center gap-2 py-1 text-sm">
        <span aria-hidden="true" className={`inline-block size-1.5 shrink-0 rounded-full ${toolRowDotClass(rowStatus)}`} />
        <span className="truncate font-mono text-xs">{name}</span>
        {statusWord ? (
          <span
            className={
              rowStatus === 'error'
                ? 'shrink-0 text-xs text-destructive'
                : 'shrink-0 text-xs text-muted-foreground'
            }
          >
            {statusWord}
          </span>
        ) : null}
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t.common.hide : t.common.reveal}
            onClick={() => setExpanded((prev) => !prev)}
            className="shrink-0 px-1 font-mono text-xs text-muted-foreground"
          >
            {expanded ? '⌄' : '›'}
          </button>
        ) : null}
      </div>
      {expandable && expanded && typeof detail === 'string' ? (
        <pre className="mb-1 ml-4 overflow-x-auto border-l border-border pl-2 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
          {detail.slice(0, 2000)}
        </pre>
      ) : null}
    </div>
  );
}
