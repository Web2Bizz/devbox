'use client';

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@web2bizz/ui/widgets';
import { ErrorState } from '../../states';
import { useI18n } from '../../../i18n';
import { ChatMessageRow } from '../chat-message';
import { ChatToolTimeline, formatVisibleFallback, getVisibleToolEvents } from '../chat-tool-timeline';
import { ChatThinkingRow } from '../chat-thinking-row';
import { ChatStreamingRow } from '../chat-streaming-row';
import { ChatThreadEmpty } from '../chat-thread-empty';
import { ChatThreadLoading } from '../chat-thread-loading';
import type { ChatThreadProps } from './types';

/**
 * Thread widget: kit `MessageScroller` + branches + item order.
 * Geometry comes from the route layout via `className` — no viewport-bound
 * height of its own. `pt` underlap on the scroller content stays: messages start below the Header and scroll underneath it (underlap).
 */
export function ChatThread({
  messages,
  streamingText,
  reasoningText = '',
  loading = false,
  sending = false,
  error = null,
  onRetry,
  toolTrace = [],
  activeAgentName,
  activeToolName,
  onFork,
  onRevert,
  className,
  composerHeight = 0,
}: ChatThreadProps) {
  const { t } = useI18n();
  const thinking = sending && !streamingText;
  const hasReasoning = reasoningText.length > 0;
  const hasReasoningTrace = toolTrace.some((event) => event.kind === 'reasoning');
  const reasoningActive = hasReasoning || hasReasoningTrace;
  const visibleTrace = getVisibleToolEvents(toolTrace);
  const hasLiveTrace = visibleTrace.length > 0 || activeToolName || hasReasoning;
  // Explicit fallback when the thinking trace is empty (ask/direct idle or a
  // model without reasoning): the last VISIBLE agent step keeps the thinking and
  // streaming rows from rendering a mute shimmer. Never invents content and
  // never leaks raw transport (`POST /api/...`, SSE) — only the human
  // `tool`/`reasoning` line via `t.chat` (full raw trace stays in the
  // timeline `<details>` for debugging).
  const fallbackText = formatVisibleFallback(toolTrace, t);

  if (loading && messages.length === 0 && !streamingText && !hasReasoning && !error) {
    return <ChatThreadLoading />;
  }

  if (error && messages.length === 0 && !streamingText && !hasReasoning && !thinking) {
    return (
      <div className="min-h-[20rem] px-1 pt-[calc(var(--header-height)_+_1rem)]">
        <ErrorState message={error} onRetry={onRetry} retryLabel={t.chat.retry} />
      </div>
    );
  }

  if (messages.length === 0 && !streamingText && !hasReasoning && !thinking) {
    return <ChatThreadEmpty />;
  }

  return (
    <div className={className ? `grid min-h-0 gap-2 ${className}` : 'grid min-h-0 gap-2'}>
      {error ? <ErrorState message={error} onRetry={onRetry} retryLabel={t.chat.retry} /> : null}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="h-full min-h-0">
          <MessageScrollerViewport aria-label={t.chat.title} className="min-h-0 px-1">
            <MessageScrollerContent className="gap-1 pt-[calc(var(--header-height)_+_1rem)] pb-36" aria-live="polite">
              {messages.map((m) => (
                <MessageScrollerItem key={m.id} messageId={m.id}>
                  <ChatMessageRow message={m} onFork={onFork} onRevert={onRevert} />
                </MessageScrollerItem>
              ))}
              {hasLiveTrace ? (
                <MessageScrollerItem messageId="chat-tools-timeline">
                  <ChatToolTimeline events={toolTrace} liveToolName={activeToolName} liveReasoningText={hasReasoning ? reasoningText : null} />
                </MessageScrollerItem>
              ) : null}
              {thinking && (
                <MessageScrollerItem messageId="chat-thinking" scrollAnchor>
                  <ChatThinkingRow activeAgentName={activeAgentName} activeToolName={activeToolName} reasoningText={reasoningText} reasoningActive={reasoningActive} fallbackText={fallbackText} />
                </MessageScrollerItem>
              )}
              {streamingText && (
                <MessageScrollerItem messageId="chat-streaming" scrollAnchor>
                  <ChatStreamingRow streamingText={streamingText} activeAgentName={activeAgentName} activeToolName={activeToolName} reasoningText={reasoningText} fallbackText={fallbackText} />
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" variant="outline" size="sm" className="absolute data-[direction=end]:bottom-[128px]" style={composerHeight > 0 ? { bottom: composerHeight + 20 } : undefined} aria-label={t.chat.scrollToEnd}>
            {t.chat.scrollToEnd}
          </MessageScrollerButton>
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
