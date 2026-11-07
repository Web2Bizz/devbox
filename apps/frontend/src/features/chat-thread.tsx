'use client';

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@web2bizz/ui/widgets';
import { ErrorState } from '../components/states';
import type { ChatMessage, ChatToolEvent } from '../hooks/useChat';
import { useI18n } from '../i18n';
import { ChatMessageRow } from '../components/chat/chat-message';
import { ChatToolsTimeline } from '../components/chat/chat-window/chat-tools-timeline';
import { ChatThinkingRow } from '../components/chat/chat-window/chat-thinking-row';
import { ChatStreamingRow } from '../components/chat/chat-window/chat-streaming-row';
import { ChatThreadEmpty } from '../components/chat/chat-window/chat-thread-empty';
import { ChatThreadLoading } from '../components/chat/chat-window/chat-thread-loading';

export type ChatThreadProps = {
  messages: Array<ChatMessage>;
  streamingText: string;
  loading?: boolean;
  sending?: boolean;
  error?: string | null;
  onRetry?: () => void;
  toolTrace?: Array<ChatToolEvent>;
  activeAgentName?: string;
  activeToolName?: string;
  onFork?: (messageId: string) => void;
  onRevert?: (messageId: string) => void;
};

/**
 * Слой композиции треда (плоская фича, CODE_OF_CONDUCT §1).
 * Владеет расположением: `grid`, скроллер, порядок строк.
 * Строки — глупые компоненты из `components/chat/chat-window/*`.
 */
export function ChatThread({
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
}: ChatThreadProps) {
  const { t } = useI18n();
  const thinking = sending && !streamingText;

  if (loading && messages.length === 0 && !streamingText && !error) {
    return <ChatThreadLoading />;
  }

  if (error && messages.length === 0 && !streamingText && !thinking) {
    return (
      <div className="h-[calc(100dvh_-_9rem)] min-h-[20rem] px-1 pt-[calc(var(--header-height)_+_1rem)]">
        <ErrorState message={error} onRetry={onRetry} retryLabel={t.chat.retry} />
      </div>
    );
  }

  if (messages.length === 0 && !streamingText && !thinking) {
    return <ChatThreadEmpty />;
  }

  return (
    <div className="grid gap-2">
      {error ? <ErrorState message={error} onRetry={onRetry} retryLabel={t.chat.retry} /> : null}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="h-[calc(100dvh_-_9rem)] min-h-[20rem]">
          <MessageScrollerViewport aria-label={t.chat.title} className="px-1">
            <MessageScrollerContent className="gap-1 pt-[calc(var(--header-height)_+_1rem)]" aria-live="polite">
              {messages.map((m) => (
                <MessageScrollerItem key={m.id} messageId={m.id}>
                  <ChatMessageRow message={m} onFork={onFork} onRevert={onRevert} />
                </MessageScrollerItem>
              ))}
              {toolTrace.length > 0 || activeToolName ? (
                <MessageScrollerItem messageId="chat-tools-timeline">
                  <ChatToolsTimeline events={toolTrace} liveToolName={activeToolName} />
                </MessageScrollerItem>
              ) : null}
              {thinking && (
                <MessageScrollerItem messageId="chat-thinking" scrollAnchor>
                  <ChatThinkingRow activeAgentName={activeAgentName} activeToolName={activeToolName} />
                </MessageScrollerItem>
              )}
              {streamingText && (
                <MessageScrollerItem messageId="chat-streaming" scrollAnchor>
                  <ChatStreamingRow streamingText={streamingText} activeAgentName={activeAgentName} activeToolName={activeToolName} />
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" variant="outline" size="sm" className="absolute right-3 bottom-3" aria-label={t.chat.scrollToEnd}>
            {t.chat.scrollToEnd}
          </MessageScrollerButton>
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
