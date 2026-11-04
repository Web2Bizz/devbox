'use client';

import { Skeleton } from '@web2bizz/ui/components';
import {
  Bubble,
  BubbleContent,
  Message,
  MessageContent,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageText,
  ShimmerText,
} from '@web2bizz/ui/widgets';
import { EmptyState, ErrorState } from '../../states';
import type { ChatMessage } from '../../../hooks/useChat';
import { useI18n } from '../../../i18n';
import { ChatMessageRow } from '../chat-message';
import { AgentThinking } from './agent-thinking';

export type ChatWindowProps = {
  messages: ChatMessage[];
  streamingText: string;
  loading?: boolean;
  sending?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

/**
 * Thread list on top of the kit `MessageScroller` (0.26.3 `widgets`).
 *
 * The kit scroller replaces the hand-rolled one: anchoring, streaming
 * auto-follow, `scroll-fade-*` edges, the "jump to latest" button and the
 * `role=log` / `aria-relevant` content semantics all come from it
 * (`MessageScrollerProvider autoScroll defaultScrollPosition="end"`). Rows
 * are `MessageScrollerItem`s keyed by message id; the live answer is the
 * last item with `scrollAnchor` so auto-follow tracks it while it streams.
 * The height contract stays app-owned: the scroller fills the column from
 * the very top of the panel (its box slides UNDER the Header — Header is
 * `z-30` with a translucent `bg-card/80` + blur, so the thread visibly goes
 * behind the bar) down to the pinned composer. The scroll content itself
 * carries `pt-[calc(var(--header-height)_+_1rem)]`, so the first message
 * starts below the bar and only scrolls underneath it.
 * Loading/error/empty still go through states.tsx (DESIGN §7).
 *
 * Role badges are gone: the thread is a plain list of chat rows. The agent
 * status (thinking / streaming) lives UNDER the assistant message, as in
 * the mobile app — the thinking row is a bare `ShimmerText` line and the
 * streaming row renders its `ShimmerText` after the ghost bubble, not in a
 * header marker.
 *
 * Error replaces the thread instead of being appended below it. The
 * scroller already fills the viewport down to the pinned composer
 * (fixed, `z-20`, `chat-section.tsx`), so anything rendered after the
 * scroller lands under/below the composer and is invisible. The error
 * branch is therefore checked first and renders `ErrorState` in the same
 * viewport-bound box as loading/empty (`100dvh − 9rem`, `min-h`, `pt`),
 * so the alert sits in the visible area above the composer. `onRetry` is
 * passed through optional — `ErrorState` only draws the button when the
 * callback exists.
 */
export function ChatWindow({
  messages,
  streamingText,
  loading = false,
  sending = false,
  error = null,
  onRetry,
}: ChatWindowProps) {
  const { t } = useI18n();
  const thinking = sending && !streamingText;

  if (loading && messages.length === 0 && !streamingText) {
    return (
      <div
        className="grid gap-2 px-1 pt-[calc(var(--header-height)_+_1rem)]"
        aria-busy="true"
        aria-label={t.common.loadingPage}
      >
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[calc(100dvh_-_9rem)] min-h-[20rem] px-1 pt-[calc(var(--header-height)_+_1rem)]">
        <ErrorState message={error} onRetry={onRetry} retryLabel={t.chat.retry} />
      </div>
    );
  }

  if (messages.length === 0 && !streamingText && !thinking) {
    // Empty thread: same viewport-bound box as the scroller
    // (`100dvh − 9rem`, see below) so the placeholder sits in the MIDDLE
    // of the visible area — between the bar and the pinned composer —
    // instead of sliding under the Header. `pt` clears the bar, flex
    // centers the copy in what remains.
    return (
      <div className="flex h-[calc(100dvh_-_9rem)] min-h-[20rem] items-center justify-center px-4 pt-[calc(var(--header-height)_+_1rem)]">
        <EmptyState title={t.chat.emptyTitle} description={t.chat.emptyDesc} />
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="h-[calc(100dvh_-_9rem)] min-h-[20rem]">
          <MessageScrollerViewport aria-label={t.chat.title} className="px-1">
            <MessageScrollerContent
              className="gap-1 pt-[calc(var(--header-height)_+_1rem)]"
              aria-live="polite"
            >
              {messages.map((m) => (
                <MessageScrollerItem key={m.id} messageId={m.id}>
                  <ChatMessageRow message={m} />
                </MessageScrollerItem>
              ))}
              {thinking && (
                <MessageScrollerItem messageId="chat-thinking" scrollAnchor>
                  <div data-testid="chat-thinking" aria-busy="true" className="py-2">
                    <AgentThinking />
                  </div>
                </MessageScrollerItem>
              )}
              {streamingText && (
                <MessageScrollerItem messageId="chat-streaming" scrollAnchor>
                  <Message align="start" className="py-3" data-testid="chat-streaming">
                    <MessageContent>
                      <Bubble variant="ghost" align="start">
                        <BubbleContent>
                          <MessageText className="whitespace-pre-wrap text-sm leading-relaxed">
                            {streamingText}
                          </MessageText>
                          <span
                            aria-hidden="true"
                            className="chat-cursor animate-pulse text-muted-foreground"
                          >
                            ▍
                          </span>
                        </BubbleContent>
                      </Bubble>
                      <div className="pt-1" data-testid="chat-streaming-status">
                        <ShimmerText>{t.chat.streaming}</ShimmerText>
                      </div>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            direction="end"
            variant="outline"
            size="sm"
            className="absolute right-3 bottom-3"
            aria-label={t.chat.scrollToEnd}
          >
            {t.chat.scrollToEnd}
          </MessageScrollerButton>
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
