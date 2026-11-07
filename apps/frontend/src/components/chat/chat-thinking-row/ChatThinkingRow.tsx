'use client';

import { Badge } from '@web2bizz/ui/components';
import { useI18n } from '../../../i18n';
import { ChatLiveStatus } from '../chat-live-status';
import type { ChatThinkingRowProps } from './types';

/** Live "thinking" row: bare ShimmerText line + agent/tool badges. */
export function ChatThinkingRow({ activeAgentName, activeToolName }: ChatThinkingRowProps) {
  const { t } = useI18n();
  return (
    <div data-testid="chat-thinking" aria-busy="true" className="flex flex-wrap items-center gap-2 py-2">
      <ChatLiveStatus activeAgentName={activeAgentName} activeToolName={activeToolName} />
      {activeAgentName ? (
        <Badge variant="secondary" data-testid="chat-active-agent">
          {t.chat.activeAgent}: {activeAgentName}
        </Badge>
      ) : null}
      {activeToolName ? (
        <Badge variant="secondary" data-testid="chat-active-tool">
          {t.chat.activeTool}: {activeToolName}
        </Badge>
      ) : null}
    </div>
  );
}
