'use client';

import { Badge, Skeleton } from '@web2bizz/ui/components';
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
import type { ChatMessage, ChatToolEvent } from '../../../hooks/useChat';
import { useI18n } from '../../../i18n';
import { ChatMessageRow } from '../chat-message';
import { getVisibleToolEvents } from '../chat-tool-timeline/types';
import { ChatToolsTimeline } from './chat-tools-timeline';
import { AgentThinking } from './agent-thinking';

export type ChatWindowProps = {
  messages: ChatMessage[];
  streamingText: string;
  loading?: boolean;
  sending?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Chronological tool trace (see useChat) — rendered as a timeline inside the thread. */
  toolTrace?: ChatToolEvent[];
  /** Display name of the agent owning the in-flight turn. */
  activeAgentName?: string;
  /** Tool name reported by the live part frames (null/absent while idle). */
  activeToolName?: string;
  /** Fork action from a message row (see ChatSection dialog wiring). */
  onFork?: (messageId: string) => void;
  /** Revert action from a message row (see ChatSection dialog wiring). */
  onRevert?: (messageId: string) => void;
};

/**
 * Thread list on top of the kit `MessageScroller` (0.26.3 `widgets`).
 *
 * The kit scroller replaces the hand-rolled one: anchoring, streaming
 * auto-follow, `scroll-fade-*` edges, the "jump to latest" button and the
 * `role=log` / `aria-relevant` content semantics all come from it
 * (`MessageScrollerProvider autoScroll defaultScrollPosition="end"`). Rows
 * are `MessageScrollerItem`s keyed by message id; the tool timeline is an
 * ordinary item (no `scrollAnchor`) so it never steals auto-follow; only
 * the live rows (thinking/streaming) carry `scrollAnchor` so auto-follow
 * tracks them while they stream. The height contract stays app-owned: the scroller fills the column from
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
 * Error policy (C6): the error NEVER replaces the thread. A terminal
 * failure (`stream.error`, failed REST history) renders as an `ErrorState`
 * banner ABOVE the thread with retry — messages + live streaming stay
 * visible. Only an empty thread with an error renders the full ErrorState.
 * Transient SSE breaks never set an error at all (quiet backoff in useChat).
 */
export function ChatWindow({
  messages,
  streamingText,
  loading = false,
  sending = false,
  error = null,
  onRetry,
  toolTrace = [],
  activeAgentName,
  activeToolName,
  onFork,
  onRevert,
}: ChatWindowProps) {
  const { t } = useI18n();
  const thinking = sending && !streamingText;
  // User-visible steps only: internal transport (POST/SSE/auth/…) stays in
  // state for the debug `<details>` but never creates a timeline item alone.
  const hasVisibleTrace = getVisibleToolEvents(toolTrace).length > 0;

  if (loading && messages.length === 0 && !streamingText && !error) {
    return (
      <div
        className="grid auto-rows-min content-start gap-2 self-start px-1 pt-[calc(var(--header-height)_+_1rem)]"
        aria-busy="true"
        aria-label={t.common.loadingPage}
      >
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  // Terminal error with an empty thread: full ErrorState (nothing to preserve).
  // With a live thread the error renders as a banner ABOVE it (see below).
  if (error && messages.length === 0 && !streamingText && !thinking) {
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
      {error ? <ErrorState message={error} onRetry={onRetry} retryLabel={t.chat.retry} /> : null}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="h-[calc(100dvh_-_9rem)] min-h-[20rem]">
          <MessageScrollerViewport aria-label={t.chat.title} className="px-1">
            <MessageScrollerContent
              className="gap-1 pt-[calc(var(--header-height)_+_1rem)]"
              aria-live="polite"
            >
              {messages.map((m) => (
                <MessageScrollerItem key={m.id} messageId={m.id}>
                  <ChatMessageRow message={m} onFork={onFork} onRevert={onRevert} />
                </MessageScrollerItem>
              ))}
              {/*
                Tool timeline INSIDE the thread (ordinary MessageScrollerItem,
                never scrollAnchor): kit auto-follow keeps tracking only
                thinking/streaming. Empty/error states return above, so the
                timeline only ever sits on a real thread.
              */}
              {hasVisibleTrace || activeToolName ? (
                <MessageScrollerItem messageId="chat-tools-timeline">
                  <ChatToolsTimeline events={toolTrace} liveToolName={activeToolName} />
                </MessageScrollerItem>
              ) : null}
              {thinking && (
                <MessageScrollerItem messageId="chat-thinking" scrollAnchor>
                  <div
                    data-testid="chat-thinking"
                    aria-busy="true"
                    className="flex flex-wrap items-center gap-2 py-2"
                  >
                    <AgentThinking
                      activeAgentName={activeAgentName}
                      activeToolName={activeToolName}
                    />
                    {activeToolName ? (
                      <Badge variant="secondary" data-testid="chat-active-tool">
                        {t.chat.activeTool}: {activeToolName}
                      </Badge>
                    ) : null}
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
                      <div
                        className="flex flex-wrap items-center gap-2 pt-1"
                        data-testid="chat-streaming-status"
                      >
                        <ShimmerText>{t.chat.streaming}</ShimmerText>
                        {activeToolName ? (
                          <Badge variant="secondary">{t.chat.activeTool}: {activeToolName}</Badge>
                        ) : null}
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
