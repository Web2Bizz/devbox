'use client';

import { Badge } from '@web2bizz/ui/components';
import { Bubble, BubbleContent, Message, MessageContent, MessageText, ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../../i18n';
import type { ChatStreamingRowProps } from './types';

/** Live streaming row: ghost bubble + cursor + status line under it. */
export function ChatStreamingRow({ streamingText, activeToolName, reasoningText = '', fallbackText = null }: ChatStreamingRowProps) {
  const { t } = useI18n();
  const hasReasoning = reasoningText.length > 0;
  const fallback = typeof fallbackText === 'string' && fallbackText.trim().length > 0 ? fallbackText.slice(0, 500) : null;
  return (
    <Message align="start" className="py-3" data-testid="chat-streaming">
      <MessageContent>
        {hasReasoning ? (
          <p data-testid="chat-reasoning" className="whitespace-pre-wrap text-xs text-muted-foreground">
            {reasoningText.slice(0, 500)}
          </p>
        ) : fallback ? (
          <p data-testid="chat-reasoning-fallback" className="whitespace-pre-wrap text-xs text-muted-foreground">
            {fallback}
          </p>
        ) : null}
        <Bubble variant="ghost" align="start">
          <BubbleContent>
            <MessageText className="whitespace-pre-wrap text-sm leading-relaxed">{streamingText}</MessageText>
            <span aria-hidden="true" className="chat-cursor animate-pulse text-muted-foreground">
              ▍
            </span>
          </BubbleContent>
        </Bubble>
        <div className="flex flex-wrap items-center gap-2 pt-1" data-testid="chat-streaming-status">
          <ShimmerText>{t.chat.streaming}</ShimmerText>
          {activeToolName ? (
            <Badge variant="secondary">
              {t.chat.activeTool}: {activeToolName}
            </Badge>
          ) : null}
        </div>
      </MessageContent>
    </Message>
  );
}
