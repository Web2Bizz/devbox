'use client';

import { useEffect, useRef } from 'react';
import { Badge, Separator, Skeleton } from '@web2bizz/ui/components';
import { Bubble, BubbleContent, Marker, MarkerContent, Message, MessageContent, MessageHeader } from '@web2bizz/ui/widgets';
import { EmptyState, ErrorState } from '../states';
import type { ChatMessage } from '../../hooks/useChat';
import { useI18n } from '../../i18n';
import { ChatMessageRow } from './chat-message';

export type ChatWindowProps = {
  messages: ChatMessage[];
  streamingText: string;
  loading?: boolean;
  sending?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

const STICK_THRESHOLD_PX = 48;

/**
 * Kit thread list (DESIGN §6 — linear rows + Separator, no Cards).
 * Rows are `ChatMessageRow` kit adapters (Message/Bubble); scroll
 * container stays app-owned to keep the role=log / sticky-48px /
 * maxHeight contracts (kit MessageScroller anchor semantics would
 * replace them — rows use kit, scroller stays custom).
 * `streamingText` renders as a live kit assistant row with a Marker
 * status + block cursor. Loading/error/empty go through states.tsx.
 */
export function ChatWindow({
  messages,
  streamingText,
  loading = false,
  error = null,
  onRetry,
}: ChatWindowProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stuckRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingText]);

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
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="overflow-y-auto overscroll-contain"
      style={{ maxHeight: 'var(--chat-list-max-h, 60dvh)' }}
      role="log"
      aria-live="polite"
      aria-label={t.chat.title}
    >
      <ul className="grid">
        {messages.map((m, i) => (
          <li key={m.id}>
            <ChatMessageRow message={m} />
            {(i < messages.length - 1 || streamingText) && <Separator className="my-1" />}
          </li>
        ))}
        {streamingText && (
          <li>
            <Message align="start" className="py-3" data-testid="chat-streaming">
              <MessageHeader>
                <Badge color="success" variant="soft">
                  {t.chat.assistant}
                </Badge>
                <Marker>
                  <MarkerContent className="shimmer">{t.chat.streaming}</MarkerContent>
                </Marker>
              </MessageHeader>
              <MessageContent>
                <Bubble variant="muted" align="start">
                  <BubbleContent>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {streamingText}
                      <span aria-hidden="true" className="chat-cursor animate-pulse text-muted-foreground">
                        ▍
                      </span>
                    </p>
                  </BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
          </li>
        )}
      </ul>
      {error && onRetry && (
        <div className="mt-3">
          <ErrorState message={error} onRetry={onRetry} retryLabel={t.chat.retry} />
        </div>
      )}
    </div>
  );
}
