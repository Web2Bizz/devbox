'use client';

import { Badge, Skeleton } from '@web2bizz/ui/components';
import {
  Bubble,
  BubbleContent,
  Marker,
  MarkerContent,
  Message,
  MessageContent,
  MessageHeader,
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
 * The height contract stays app-owned: `max-h-[var(--chat-list-max-h,60dvh)]`
 * caps the panel so `.app-content` keeps the scroll.
 * Loading/error/empty still go through states.tsx (DESIGN §7).
 */
export function ChatWindow({
  messages,
  streamingText,
  loading = false,
  error = null,
  onRetry,
}: ChatWindowProps) {
  const { t } = useI18n();

  if (loading && messages.length === 0 && !streamingText) {
    return (
      <div className="grid gap-2" aria-busy="true" aria-label={t.common.loadingPage}>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  if (error && messages.length === 0 && !streamingText) {
    return <ErrorState message={error} onRetry={onRetry} retryLabel={t.chat.retry} />;
  }

  if (messages.length === 0 && !streamingText) {
    return <EmptyState title={t.chat.emptyTitle} description={t.chat.emptyDesc} />;
  }

  return (
    <div className="grid gap-2">
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="max-h-[var(--chat-list-max-h,60dvh)] min-h-0">
          <MessageScrollerViewport aria-label={t.chat.title} className="px-1">
            <MessageScrollerContent className="gap-1" aria-live="polite">
              {messages.map((m) => (
                <MessageScrollerItem key={m.id} messageId={m.id}>
                  <ChatMessageRow message={m} />
                </MessageScrollerItem>
              ))}
              {streamingText && (
                <MessageScrollerItem messageId="chat-streaming" scrollAnchor>
                  <Message align="start" className="py-3" data-testid="chat-streaming">
                    <MessageHeader>
                      <Badge color="success" variant="soft">
                        {t.chat.assistant}
                      </Badge>
                      <Marker>
                        <MarkerContent>
                          <ShimmerText>{t.chat.streaming}</ShimmerText>
                        </MarkerContent>
                      </Marker>
                    </MessageHeader>
                    <MessageContent>
                      <Bubble variant="muted" align="start">
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
      {error && onRetry && <ErrorState message={error} onRetry={onRetry} retryLabel={t.chat.retry} />}
    </div>
  );
}
