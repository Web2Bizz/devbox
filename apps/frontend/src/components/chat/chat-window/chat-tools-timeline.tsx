'use client';

import { useState } from 'react';
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@web2bizz/ui/components';
import { ShimmerText } from '@web2bizz/ui/widgets';
import type { ChatToolEvent } from '../../../hooks/useChat';
import { useI18n } from '../../../i18n';
import {
  formatRawToolEventLine,
  formatToolEventStatus,
  formatToolEventTitle,
  getVisibleToolEvents,
} from '../chat-tool-timeline/types';

export type ChatToolsTimelineProps = {
  /** Chronological tool calls of the session (append-only, see useChat). */
  events: ChatToolEvent[];
  /** Tool name currently reported by the live part frames (null while idle). */
  liveToolName?: string | null;
};

/**
 * Chronological tool timeline of the current chat request, rendered INSIDE
 * the kit `MessageScroller` as an ordinary `MessageScrollerItem` (never with
 * `scrollAnchor`) so the streaming auto-follow anchor stays on thinking/streaming.
 * Hidden while empty, and the error/empty branches of `ChatWindow` return before it, so it never shows on those
 * states either.
 *
 * User view shows agent steps only (`tool` + `reasoning` with human labels
 * via `t.chat`); internal transport kinds stay in state for debugging and
 * surface only as `title` tooltips + collapsed technical `<details>`.
 *
 * Kit-only chrome: `Collapsible` for the fold, `Badge` for the call count,
 * token classes (`text-muted-foreground`, `bg-muted`) for the rows — no hex.
 */
export function ChatToolsTimeline({ events, liveToolName }: ChatToolsTimelineProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const visibleEvents = getVisibleToolEvents(events);

  if (visibleEvents.length === 0 && !liveToolName) return null;

  const total = visibleEvents.length + (liveToolName ? 1 : 0);
  const hasRawDetails = events.length > 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="chat-tools-timeline"
      className="px-1 pb-2"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        >
          <span className="flex-1">{t.chat.toolsTitle}</span>
          <Badge variant="secondary" aria-label={`${total}`}>
            {total}
          </Badge>
          <span aria-hidden="true">▾</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {visibleEvents.length === 0 && !liveToolName ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">{t.chat.toolsEmpty}</p>
        ) : (
          <ol className="grid gap-1 px-2 py-1">
            {visibleEvents.map((event, index) => {
              const title = formatToolEventTitle(event, t);
              const status = formatToolEventStatus(event, t);
              return (
                <li
                  key={event.id}
                  data-testid="chat-tool-event"
                  data-kind={event.kind}
                  title={formatRawToolEventLine(event)}
                  className="flex items-baseline gap-2 text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="shrink-0 tabular-nums text-muted-foreground"
                  >
                    {index + 1}.
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {new Date(event.at).toLocaleTimeString()}
                  </span>
                  <span className="min-w-0 flex-1 break-words font-mono text-xs">
                    {title}
                  </span>
                  {status ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {status}
                    </span>
                  ) : null}
                </li>
              );
            })}
            {liveToolName ? (
              <li
                data-testid="chat-tool-live"
                className="flex items-baseline gap-2 text-sm"
                aria-busy="true"
              >
                <span
                  aria-hidden="true"
                  className="shrink-0 tabular-nums text-muted-foreground"
                >
                  {visibleEvents.length + 1}.
                </span>
                <ShimmerText>{liveToolName}</ShimmerText>
              </li>
            ) : null}
          </ol>
        )}
        {hasRawDetails ? (
          <details className="px-2 py-1" data-testid="chat-tools-details">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t.chat.toolsDetails}
            </summary>
            <ol className="grid gap-1 py-1">
              {events.map((event, index) => (
                <li
                  key={event.id}
                  data-testid="chat-tool-raw-event"
                  data-kind={event.kind}
                  title={formatRawToolEventLine(event)}
                  className="flex items-baseline gap-2 text-xs text-muted-foreground"
                >
                  <span aria-hidden="true" className="shrink-0 tabular-nums">
                    {index + 1}.
                  </span>
                  <span className="min-w-0 flex-1 break-words font-mono">
                    {formatRawToolEventLine(event)}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
