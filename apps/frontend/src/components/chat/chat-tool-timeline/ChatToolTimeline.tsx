'use client';

import { useState } from 'react';
import { useI18n } from '../../../i18n';
import {
  formatRawToolEventLine,
  formatToolEventStatus,
  formatToolEventTitle,
  getVisibleToolEvents,
  isToolDetailExpandable,
  toolRowDotClass,
  toToolRowStatus,
  type ChatToolEvent,
  type ChatToolTimelineProps,
  type ToolRowStatus,
} from './types';

/**
 * Reasoning timeline of the current chat request — flat Claude/Cursor-style
 * rows, no kit `ToolCall` cards of its own.
 *
 * User view shows agent steps only (`tool` + `reasoning` via
 * `getVisibleToolEvents`, human labels via `t.chat`); internal transport
 * kinds (`auth/create-session/history/prompt/sse/reload/interrupt`) stay in
 * `useChat` state for debugging and never render — no raw
 * `POST /api/...`, no technical `<details>` block.
 *
 * Mapping: one stored event is one flat row (status dot + mono tool name +
 * human status word, `detail` → `running`/`done`/`error` via
 * `toToolRowStatus`). The real `detail` payload sits behind an expander;
 * phase keywords render as the status word only — no invented `args`/
 * `result` fixtures. Stored steps keep their terminal status
 * (`done`/`error`); the live rows (`liveToolName`, `liveReasoningText`)
 * are `running`. Failed rows start expanded.
 *
 * Flat content per DESIGN.md §7: rows + a `border-l` detail rail, kit
 * tokens only (`text-muted-foreground`/`text-destructive`, `font-mono`) —
 * no `Card`, no shadows, no gradients, no transforms.
 */
export function ChatToolTimeline({ events, liveToolName, liveReasoningText = null }: ChatToolTimelineProps) {
  const { t } = useI18n();

  const visibleEvents = getVisibleToolEvents(events);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        visibleEvents
          .filter(
            (event) =>
              toToolRowStatus(event.detail) === 'error' && isToolDetailExpandable(event.detail),
          )
          .map((event) => event.id),
      ),
  );

  if (visibleEvents.length === 0 && !liveToolName && !liveReasoningText) return null;

  const live = Boolean(liveToolName ?? liveReasoningText);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderStoredRow = (event: ChatToolEvent) => {
    const status: ToolRowStatus = toToolRowStatus(event.detail);
    const expandable = isToolDetailExpandable(event.detail);
    const expanded = expandedIds.has(event.id);
    const name = formatToolEventTitle(event, t);
    const statusWord = formatToolEventStatus(event, t);
    return (
      <div
        key={event.id}
        data-testid="chat-tool-call"
        data-kind={event.kind}
        data-status={status}
        title={formatRawToolEventLine(event)}
        className="px-1 py-0.5"
      >
        <div className="flex min-w-0 items-center gap-2 py-1 text-sm">
          <span aria-hidden="true" className={`inline-block size-1.5 shrink-0 rounded-full ${toolRowDotClass(status)}`} />
          <span className="truncate font-mono text-xs">{name}</span>
          {statusWord ? (
            <span
              className={
                status === 'error'
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
              onClick={() => toggleExpanded(event.id)}
              className="shrink-0 px-1 font-mono text-xs text-muted-foreground"
            >
              {expanded ? '⌄' : '›'}
            </button>
          ) : null}
        </div>
        {expandable && expanded && typeof event.detail === 'string' ? (
          <pre className="mb-1 ml-4 overflow-x-auto border-l border-border pl-2 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
            {event.detail.slice(0, 2000)}
          </pre>
        ) : null}
      </div>
    );
  };

  return (
    <div
      data-testid="chat-tools-timeline"
      aria-busy={live ? 'true' : undefined}
      className="px-1 pb-2"
    >
      <p className="px-2 py-1.5 text-sm font-medium text-muted-foreground">{t.chat.toolsTitle}</p>
      <div className="grid gap-1">
        {visibleEvents.map(renderStoredRow)}
        {liveReasoningText ? (
          <div data-testid="chat-tool-call" data-kind="reasoning" data-status="running">
            <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-sm">
              <span aria-hidden="true" className={`inline-block size-1.5 shrink-0 rounded-full ${toolRowDotClass('running')}`} />
              <span className="truncate font-mono text-xs">{t.chat.reasoningLabel}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{t.chat.reasoningThinking}</span>
            </div>
            <p className="mb-1 ml-4 border-l border-border pl-2 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
              {liveReasoningText.slice(0, 500)}
            </p>
          </div>
        ) : null}
        {liveToolName ? (
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
        ) : null}
      </div>
    </div>
  );
}
