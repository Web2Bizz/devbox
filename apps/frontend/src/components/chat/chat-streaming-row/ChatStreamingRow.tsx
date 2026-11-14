'use client';

import { Bubble, BubbleContent, Message, MessageContent, MessageText, ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../../i18n';
import type { ChatStreamingRowProps } from './types';

/**
 * Live streaming row: ghost bubble + cursor + status line under it.
 *
 * The active tool is no longer a badge here — it renders as its own flat
 * `ChatToolRow` line in the thread chronology.
 * Single thinking source: reasoning/fallback lives ONLY in `ChatThinkingRow`
 * — this row never renders `chat-reasoning` (no second Thinking).
 */
export function ChatStreamingRow({ streamingText }: ChatStreamingRowProps) {
  const { t } = useI18n();
  return (
    <Message align="start" className="py-3" data-testid="chat-streaming">
      <MessageContent>
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
        </div>
      </MessageContent>
    </Message>
  );
}
