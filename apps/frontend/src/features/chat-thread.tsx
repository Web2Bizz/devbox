'use client';

import { MessageScrollerItem } from '@web2bizz/ui/widgets';
import type { ChatMessage, ChatToolEvent } from '../hooks/useChat';
import { useI18n } from '../i18n';
import { ChatMessageRow } from '../components/chat/chat-message';
import { ChatToolsTimeline } from '../components/chat-tools-timeline';
import { ChatThinkingRow } from '../components/chat-thinking-row';
import { ChatStreamingRow } from '../components/chat-streaming-row';
import { ChatThreadEmpty } from '../components/chat-thread-empty';
import { ChatThreadLoading } from '../components/chat-thread-loading';
import { ChatErrorBanner } from '../components/chat-error-banner';
import { ChatThreadWidget } from '../components/chat-thread-widget';

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
  /** Geometry from layout (§2): scroller height + content offset. */
  scrollerClassName?: string;
  contentClassName?: string;
};

/**
 * Слой композиции треда (плоская фича, CODE_OF_CONDUCT §1).
 * Состояние + порядок строк; геометрию получает через className от layout.
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
  scrollerClassName = 'h-full min-h-[20rem]',
  contentClassName = 'gap-1',
}: ChatThreadProps) {
  const { t } = useI18n();
  const thinking = sending && !streamingText;

  if (loading && messages.length === 0 && !streamingText && !error) {
    return <ChatThreadLoading />;
  }

  if (error && messages.length === 0 && !streamingText && !thinking) {
    return (
      <div className="min-h-[20rem] px-1">
        <ChatErrorBanner message={error} onRetry={onRetry} retryLabel={t.chat.retry} />
      </div>
    );
  }

  if (messages.length === 0 && !streamingText && !thinking) {
    return <ChatThreadEmpty />;
  }

  return (
    <div className="grid gap-2">
      <ChatErrorBanner message={error} onRetry={onRetry} retryLabel={t.chat.retry} />
      <ChatThreadWidget
        title={t.chat.title}
        scrollEndLabel={t.chat.scrollToEnd}
        scrollerClassName={scrollerClassName}
        contentClassName={contentClassName}
        viewportClassName="px-1"
      >
        {messages.map((message) => (
          <MessageScrollerItem key={message.id} messageId={message.id}>
            <ChatMessageRow message={message} onFork={onFork} onRevert={onRevert} />
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
      </ChatThreadWidget>
    </div>
  );
}
