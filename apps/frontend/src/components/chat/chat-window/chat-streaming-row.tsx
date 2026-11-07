'use client';

import { Badge } from '@web2bizz/ui/components';
import { Bubble, BubbleContent, Message, MessageContent, MessageText, ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../../i18n';

export type ChatStreamingRowProps = {
  streamingText: string;
  activeAgentName?: string;
  activeToolName?: string;
};

/** Live streaming row: ghost bubble + cursor + status line under it. */
export function ChatStreamingRow({ streamingText, activeToolName }: ChatStreamingRowProps) {
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
