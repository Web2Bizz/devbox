'use client';

import { useState } from 'react';
import { ChatInput, ChatWindow, ModelSelector } from '../../components/chat';
import { ErrorState } from '../../components/states';
import { useChat } from '../../hooks/useChat';
import { useI18n } from '../../i18n';

export type ChatSectionProps = {
  /** Existing session to scope the chat to (session = chat). */
  sessionId?: string;
  /** Rush Code project uuid — the C4 gate on every domain call. */
  projectId?: string;
};

/**
 * Chat feature section — thin composition over `useChat` + kit rows.
 *
 * Layers (AGENTS.md): page owns `<ChatSection />`, business state lives in
 * `hooks/useChat` (prompt/SSE/abort/reload over the domain /api/sessions*
 * contract — the frontend knows nothing about the underlying runner),
 * rows/composer are generic
 * `components/chat/*`. No `entities/`/`shared/` — no new deprecated
 * re-exports. Flat Content (§7): linear section, no Card wrappers.
 *
 * States: loading skeleton via `ChatWindow`, upstream failures via
 * `ErrorState` + retry (`reload` redials SSE + refetches history),
 * empty via `ChatWindow` empty copy. STOP keeps the partial stream as the
 * assistant answer (see `useChat.stop`).
 */
export function ChatSection({ sessionId, projectId }: ChatSectionProps) {
  const { t } = useI18n();
  const [aborting, setAborting] = useState(false);
  const chat = useChat({ sessionId, projectId });
  const {
    messages,
    streamingText,
    loading,
    sending,
    error,
    isEmpty,
    model,
    setModel,
    send,
    stop,
    reload,
  } = chat;

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
    <section aria-label={t.chat.title} className="grid gap-2">
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
      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        sending={sending || aborting}
        leftSlot={
          <ModelSelector
            projectId={projectId}
            model={model}
            onChange={setModel}
            disabled={sending}
          />
        }
      />
    </section>
  );
}
