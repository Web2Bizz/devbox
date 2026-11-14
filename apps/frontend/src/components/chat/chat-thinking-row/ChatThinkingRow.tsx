'use client';

import { ChatLiveStatus } from '../chat-live-status';
import type { ChatThinkingRowProps } from './types';

/**
 * Live "thinking" row: status line + reasoning preview.
 *
 * The active tool is no longer a badge here — every tool/reasoning step is
 * its own flat row in the thread (`ChatToolRow`), so this row only carries
 * the agent status and the thinking trace.
 */
export function ChatThinkingRow({ activeAgentName, reasoningText = '', reasoningActive, fallbackText = null }: ChatThinkingRowProps) {
  const hasReasoning = reasoningText.length > 0;
  const liveReasoningActive = reasoningActive ?? hasReasoning;
  const fallback = typeof fallbackText === 'string' && fallbackText.trim().length > 0 ? fallbackText.slice(0, 500) : null;
  return (
    <div data-testid="chat-thinking" aria-busy="true" className="flex flex-wrap items-center gap-2 py-2">
      <ChatLiveStatus activeAgentName={activeAgentName} reasoningActive={liveReasoningActive} />
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
