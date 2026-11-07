'use client';

import { useState } from 'react';
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@web2bizz/ui/components';
import { ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../i18n';
import type { ChatToolsTimelineProps } from './types';

/**
 * Chronological tool timeline inside the thread (ordinary scroller item,
 * never scrollAnchor). Kit-only chrome: Collapsible + Badge + tokens.
 */
export function ChatToolsTimeline({ events, liveToolName }: ChatToolsTimelineProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  if (events.length === 0 && !liveToolName) return null;

  const total = events.length + (liveToolName ? 1 : 0);

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
        {events.length === 0 && !liveToolName ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">{t.chat.toolsEmpty}</p>
        ) : (
          <ol className="grid gap-1 px-2 py-1">
            {events.map((event, index) => (
              <li
                key={event.id}
                data-testid="chat-tool-event"
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
                  {event.label}
                </span>
                {event.detail ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {event.detail}
                  </span>
                ) : null}
              </li>
            ))}
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
                  {events.length + 1}.
                </span>
                <ShimmerText>{liveToolName}</ShimmerText>
              </li>
            ) : null}
          </ol>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
