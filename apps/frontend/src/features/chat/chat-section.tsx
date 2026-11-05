'use client';

import { useState } from 'react';
import { ChatInput, ChatWindow, AgentSelector } from '../../components/chat';
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
 * `hooks/useChat` (prompt/SSE/abort/reload over the domain /api/v1/sessions*
 * contract — the frontend knows nothing about the underlying runner),
 * rows/composer are generic
 * `components/chat/*`. No `entities/`/`shared/` — no new deprecated
 * re-exports. Flat Content (§7): linear section, no Card wrappers.
 *
 * States: loading skeleton, upstream failures (ErrorState + retry, `reload`
 * redials SSE + refetches history) and empty copy are all owned by
 * `ChatWindow` — the section just wires props so there is a single render
 * path and the alert is never duplicated under the thread. STOP keeps the
 * partial stream as the assistant answer (see `useChat.stop`).
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
    agentId,
    setAgentId,
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
      <ChatWindow
        messages={messages}
        streamingText={streamingText}
        loading={loading}
        sending={sending}
        error={error}
        onRetry={reload}
      />
      {/*
        Pinned composer: `fixed` to the viewport bottom, inset to the Content
        column (layer `p-2` + sidebar 300px + grid gap + content `px-4`).
        `z-20` stays under the Header (`z-30`). The section `pb-36` reserves
        scroll space so the last message never hides behind the card.
      */}
      <div className="fixed right-6 bottom-2 left-6 z-20 bg-background md:left-[calc(300px_+_2rem)]">
        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          sending={sending || aborting}
          leftSlot={
            <AgentSelector
              agentId={agentId}
              onChange={setAgentId}
              disabled={sending}
            />
          }
        />
      </div>
    </section>
  );
}
