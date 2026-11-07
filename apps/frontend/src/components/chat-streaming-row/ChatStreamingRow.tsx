'use client';

import { Message, MessageContent } from '@web2bizz/ui/widgets';
import { Bubble, BubbleContent, MessageText } from '@web2bizz/ui/widgets';
import { ChatLiveStatusWidget } from '../chat-live-status-widget';
import type { ChatStreamingRowProps } from './types';

/** Live streaming row: ghost bubble + cursor + status line under it. */
export function ChatStreamingRow({ streamingText, activeAgentName, activeToolName }: ChatStreamingRowProps) {
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
        <ChatLiveStatusWidget mode="streaming" activeAgentName={activeAgentName} activeToolName={activeToolName} />
      </MessageContent>
    </Message>
  );
}
