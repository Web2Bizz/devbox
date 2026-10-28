'use client';

import { useState } from 'react';
import { Button } from '@web2bizz/ui/components';
import { ChatInput, ChatWindow } from '../../components/chat';
import { ErrorState } from '../../components/states';
import { useChat } from '../../hooks/useChat';
import { useI18n } from '../../i18n';

export type ChatSectionProps = {
  /** Existing opencode session to scope the chat to (session = chat). */
  sessionId?: string;
  /** Opencode working directory, forwarded as `?directory=`. */
  directory?: string;
  /** Rush Code project id (prj-*) — forwarded as `?projectId=` (backend-gated, C4). */
  projectId?: string;
};

/**
 * Chat feature section — thin composition over `useChat` + kit rows.
 *
 * Layers (AGENTS.md): page owns `<ChatSection />`, business state lives in
 * `hooks/useChat` (prompt/SSE/abort/reload over the backend reverse-proxy
 * `/api/opencode`, same sdk as the backend), rows/composer are generic
 * `components/chat/*`. No `entities/`/`shared/` — no new deprecated
 * re-exports. Flat Content (§7): linear section, no Card wrappers.
 *
 * States: loading skeleton via `ChatWindow`, upstream failures via
 * `ErrorState` + retry (`reload` redials SSE + refetches history),
 * empty via `ChatWindow` empty copy. STOP keeps the partial stream as the
 * assistant answer (see `useChat.stop`).
 */
export function ChatSection({ sessionId, directory, projectId }: ChatSectionProps) {
  const { t } = useI18n();
  const [aborting, setAborting] = useState(false);
  const chat = useChat({ sessionId, directory, projectId });
  const { messages, streamingText, loading, sending, error, isEmpty, send, stop, reload } = chat;

  const handleSend = (text: string) => send(text);

  const handleStop = () => {
    setAborting(true);
    try {
      stop();
    } finally {
      setAborting(false);
    }
  };

  return (
    <section aria-labelledby="chat-title" className="grid gap-2">
      <h2 id="chat-title" className="text-lg font-semibold">
        {t.chat.title}
      </h2>
      <p className="text-muted-foreground text-sm">{t.chat.subtitle}</p>
      {error && isEmpty ? (
        <ErrorState message={error} onRetry={reload} retryLabel={t.chat.retry} />
      ) : (
        <ChatWindow
          messages={messages}
          streamingText={streamingText}
          loading={loading}
          sending={sending}
          error={error}
          onRetry={reload}
        />
      )}
      <ChatInput onSend={handleSend} onStop={handleStop} sending={sending || aborting} />
      {!loading && !isEmpty && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={reload}
            disabled={sending}
            aria-label={t.common.refresh}
          >
            {t.common.refresh}
          </Button>
        </div>
      )}
    </section>
  );
}
