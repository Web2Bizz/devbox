'use client';

import { ThoughtChain, ThoughtChainContent, ThoughtChainStep, ThoughtChainTrigger } from '@web2bizz/ui/widgets';
import { ChatLiveStatus } from '../chat-live-status';
import type { ChatThinkingRowProps } from './types';

/**
 * Live "thinking" row: status line + reasoning preview.
 *
 * The active tool is no longer a badge here — every tool/reasoning step is
 * its own flat row in the thread (`ChatToolRow`), so this row only carries
 * the mode status and the thinking trace as a kit `ThoughtChain`
 * (0.26.5 `widgets`): one `ThoughtChainStep` whose trigger is the live
 * mode line (`ChatLiveStatus`, kit `ShimmerText`) and whose content is
 * the reasoning preview (or the last-timeline-line fallback — never a raw
 * transport line, never invented).
 *
 * Kit status mapping: live reasoning → `active`, settled preview →
 * `done`, fallback-only (no trace yet) → `pending`. `warning`/`error`
 * unused — failures surface per-row in `ChatToolRow`, never here.
 */
export function ChatThinkingRow({ activeModeName, reasoningText = '', reasoningActive, fallbackText = null }: ChatThinkingRowProps) {
  const hasReasoning = reasoningText.length > 0;
  const liveReasoningActive = reasoningActive ?? hasReasoning;
  const fallback = typeof fallbackText === 'string' && fallbackText.trim().length > 0 ? fallbackText.slice(0, 500) : null;
  const stepStatus = liveReasoningActive ? 'active' : hasReasoning ? 'done' : 'pending';
  return (
    <div data-testid="chat-thinking" aria-busy="true" className="flex flex-wrap items-center gap-2 py-2">
      <ThoughtChain>
        <ThoughtChainStep status={stepStatus} defaultOpen={hasReasoning || fallback !== null}>
          <ThoughtChainTrigger>
            <ChatLiveStatus activeModeName={activeModeName} reasoningActive={liveReasoningActive} />
          </ThoughtChainTrigger>
          <ThoughtChainContent>
            {hasReasoning ? (
              <p data-testid="chat-reasoning" className="w-full whitespace-pre-wrap text-xs text-muted-foreground">
                {reasoningText.slice(0, 500)}
              </p>
            ) : fallback ? (
              <p data-testid="chat-reasoning-fallback" className="w-full whitespace-pre-wrap text-xs text-muted-foreground">
                {fallback}
              </p>
            ) : null}
          </ThoughtChainContent>
        </ThoughtChainStep>
      </ThoughtChain>
    </div>
  );
}
