'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ChatInput, AgentSelector } from '../../components/chat';
import { ChatThread } from '../../components/chat/chat-thread';
import { DEFAULT_AGENT_ID, listAgents } from '../../api/sessions-client';
import { useChat } from '../../hooks/useChat';
import { agentsQueryKey } from '../../hooks/query-keys';
import { useI18n } from '../../i18n';
import { ChatForkDialog } from './chat-fork-dialog';
import { ChatRevertDialog } from './chat-revert-dialog';

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
  const [forkMessageId, setForkMessageId] = useState<string | null>(null);
  const [revertMessageId, setRevertMessageId] = useState<string | null>(null);
  const chat = useChat({ sessionId, projectId });
  const {
    messages,
    streamingText,
    reasoningText,
    loading,
    sending,
    error,
    sessionId: activeSessionId,
    agentId,
    setAgentId,
    activeAgentId,
    activeToolName,
    send,
    stop,
    reload,
    toolTrace,
  } = chat;

  // Display name of the live agent — same cache entry as the selector, so no
  // extra request; the raw registry id is the honest fallback.
  const { data: agents = [] } = useQuery({
    queryKey: agentsQueryKey,
    queryFn: ({ signal }) => listAgents({ signal }),
  });
  const activeAgentName =
    activeAgentId === null
      ? undefined
      : (agents.find((agent) => agent.id === activeAgentId)?.name ?? activeAgentId);

  const handleSend = (text: string) => send(text);

  const handleStop = () => {
    setAborting(true);
    try {
      stop();
    } finally {
      setAborting(false);
    }
  };

  // Persist (C5): path `sessions/[sessionId]` stays the sessionId source;
  // `?agent=` carries the agent picker. Both survive F5; the hook itself
  // stays router-free (testable without Next) — sync lives here. Only
  // `usePathname`/`useRouter` are used (no `useSearchParams`, so no Suspense
  // boundary is required); the query string is read from window.location.
  const router = useRouter();
  const pathname = usePathname();
  const readUrlQuery = (): string => {
    if (typeof window === 'undefined') return '';
    return window.location.search.startsWith('?') ? window.location.search.slice(1) : '';
  };

  // Init: `?agent=` → picker state (fallback DEFAULT_AGENT_ID in the hook).
  useEffect(() => {
    const agent = new URLSearchParams(readUrlQuery()).get('agent');
    if (agent && agent !== agentId) setAgentId(agent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `setAgentId` → `?agent=` (replace, no scroll, no history spam).
  useEffect(() => {
    if (!pathname || typeof window === 'undefined') return;
    const next = new URLSearchParams(readUrlQuery());
    if (agentId === (next.get('agent') ?? DEFAULT_AGENT_ID)) return;
    if (agentId === DEFAULT_AGENT_ID) next.delete('agent');
    else next.set('agent', agentId);
    const qs = next.toString();
    router.replace(pathname + (qs ? `?${qs}` : ''), { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, pathname]);

  // Lazy-created session → `.../sessions/[newId]` (replace, history kept in
  // the hook — no page reload, no lost draft).
  useEffect(() => {
    if (!activeSessionId || !pathname || typeof window === 'undefined') return;
    if (pathname.endsWith(`/${activeSessionId}`)) return;
    const qs = readUrlQuery();
    const suffix = qs ? `?${qs}` : '';
    if (pathname.endsWith('/sessions')) {
      router.replace(`${pathname}/${activeSessionId}${suffix}`, { scroll: false });
      return;
    }
    const replaced = pathname.replace(/\/sessions\/[^/]+$/, `/sessions/${activeSessionId}`);
    if (replaced !== pathname) {
      router.replace(`${replaced}${suffix}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, pathname]);

  return (
    <section aria-label={t.chat.title} className="grid gap-2">
      <ChatThread
        messages={messages}
        streamingText={streamingText}
        reasoningText={reasoningText}
        loading={loading}
        sending={sending}
        error={error}
        onRetry={reload}
        toolTrace={toolTrace}
        activeAgentName={activeAgentName}
        activeToolName={activeToolName ?? undefined}
        onFork={setForkMessageId}
        onRevert={setRevertMessageId}
      />
      {/*
        Pinned composer: `fixed` to the viewport bottom, inset to the Content
        column (layer `p-2` + sidebar 300px + grid gap + content `px-4`).
        `z-20` stays under the Header (`z-30`). The section `pb-36` reserves
        scroll space so the last message never hides behind the card.
      */}
      <div className="absolute bottom-2 right-[calc((100%-300px)*0.25)] z-20 bg-background m-auto w-[50%]">
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
      <ChatForkDialog
        open={forkMessageId !== null}
        onOpenChange={(open) => {
          if (!open) setForkMessageId(null);
        }}
        sessionId={activeSessionId}
        projectId={projectId}
        messageId={forkMessageId}
      />
      <ChatRevertDialog
        open={revertMessageId !== null}
        onOpenChange={(open) => {
          if (!open) setRevertMessageId(null);
        }}
        sessionId={activeSessionId}
        projectId={projectId}
        messageId={revertMessageId}
      />
    </section>
  );
}
