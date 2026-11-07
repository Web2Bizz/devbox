'use client';

import { Badge } from '@web2bizz/ui/components';
import { useI18n } from '../../../i18n';
import { ChatLiveStatus } from '../chat-live-status';
import type { ChatThinkingRowProps } from './types';

/** Live "thinking" row: status line + agent/tool badges + reasoning preview. */
export function ChatThinkingRow({ activeAgentName, activeToolName, reasoningText = '', reasoningActive, fallbackText = null }: ChatThinkingRowProps) {
  const { t } = useI18n();
  const hasReasoning = reasoningText.length > 0;
  const liveReasoningActive = reasoningActive ?? hasReasoning;
  const fallback = typeof fallbackText === 'string' && fallbackText.trim().length > 0 ? fallbackText.slice(0, 500) : null;
  return (
    <div data-testid="chat-thinking" aria-busy="true" className="flex flex-wrap items-center gap-2 py-2">
      <ChatLiveStatus activeAgentName={activeAgentName} activeToolName={activeToolName} reasoningActive={liveReasoningActive} />
      {activeToolName ? (
        <Badge variant="secondary" data-testid="chat-active-tool">
          {t.chat.activeTool}: {activeToolName}
        </Badge>
      ) : null}
      {hasReasoning ? (
        <p data-testid="chat-reasoning" className="w-full whitespace-pre-wrap text-xs text-muted-foreground">
          {reasoningText.slice(0, 500)}
        </p>
      ) : fallback ? (
        <p data-testid="chat-reasoning-fallback" className="w-full whitespace-pre-wrap text-xs text-muted-foreground">
          {fallback}
        </p>
      ) : null}
    </div>
  );
}
