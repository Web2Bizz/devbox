'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChatInput, ModeSelector } from '../components/chat';
import { ChatThread } from '../components/chat/chat-thread';
import { DEFAULT_AGENT_ID, listAgents, resolveSessionApproval, toErrorMessage } from '../api/sessions-client';
import { useChat } from '../hooks/useChat';
import type { UseChatResult } from '../hooks/useChat';
import { agentsQueryKey, sessionStatusQueryKey, sessionsQueryKey } from '../hooks/query-keys';
import { useI18n } from '../i18n';
import { ChatForkDialog } from './chat-fork-dialog';
import { ChatRevertDialog } from './chat-revert-dialog';

export type ChatSectionProps = {
  /** Existing session to scope the chat to (session = chat). */
  sessionId?: string;
  /** Rush Code project uuid — the C4 gate on every domain call. */
  projectId?: string;
  className?: string;
  composerClassName?: string;
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
 * States: loading skeleton, upstream failures (toast + retry, `reload`
 * redials SSE + refetches history) and empty copy are all owned by
 * `ChatThread` — the section just wires props so there is a single render
 * path and the toast is never duplicated under the thread. STOP keeps the
 * partial stream as the assistant answer (see `useChat.stop`).
 *
 * Geometry comes from the route layout via `className`/`composerClassName` —
 * the section owns no `h-[calc]`/`absolute` pin of its own.
 */
export function ChatSection({ sessionId, projectId, className, composerClassName }: ChatSectionProps) {
  const { t } = useI18n();
  const [aborting, setAborting] = useState<boolean>(false);
  const [composerHeight, setComposerHeight] = useState<number>(0);
  const composerRef = useRef<HTMLDivElement | null>(null);

  // The jump button lives in the thread but must clear the composer, whose
  // height grows with the prompt (autoresize up to maxHeight). Measure it.
  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    const measure = () => setComposerHeight(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const [forkMessageId, setForkMessageId] = useState<string | null>(null);
  const [revertMessageId, setRevertMessageId] = useState<string | null>(null);
  const chat: UseChatResult = useChat({ sessionId, projectId });

  // Approval gate (WEB-20 / D2): the parked long-session turn resolves via
  // POST /api/v1/sessions/{id}/approval (approve resumes the same thread,
  // reject parks on paused). The gate itself clears via SSE
  // (`session.approval.resolved` in useSseConnection) — here we only fire
  // the decision and invalidate the status/list caches; the thread stays
  // untouched on both paths (no optimistic history edits).
  const queryClient = useQueryClient();
  const [approvalPending, setApprovalPending] = useState<boolean>(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const handleApproval = (decision: 'approve' | 'reject'): void => {
    if (!projectId || !chat.sessionId || !chat.approval || approvalPending) return;
    setApprovalPending(true);
    setApprovalError(null);
    resolveSessionApproval(projectId, chat.sessionId, decision)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: sessionsQueryKey(projectId) });
        void queryClient.invalidateQueries({ queryKey: sessionStatusQueryKey(projectId) });
      })
      .catch((e: unknown) => {
        setApprovalError(toErrorMessage(e));
      })
      .finally(() => {
        setApprovalPending(false);
      });
  };

  const handleApprove = (): void => handleApproval('approve');

  const handleReject = (): void => handleApproval('reject');

  // Display name of the live mode — same cache entry as the selector, so no
  // extra request; the raw registry id is the honest fallback.
  const { data: modes = [] } = useQuery({
    queryKey: agentsQueryKey,
    queryFn: ({ signal }) => listAgents({ signal }),
  });
  const activeModeName: string | undefined =
    chat.activeModeId === null
      ? undefined
      : (modes.find((mode) => mode.id === chat.activeModeId)?.name ?? chat.activeModeId);

  const handleSend = async (text: string): Promise<void> => await chat.send(text);

  const handleStop = (): void => {
    setAborting(true);
    try {
      chat.stop();
    } finally {
      setAborting(false);
    }
  };

  // Persist (C5): path `sessions/[sessionId]` stays the sessionId source;
  // `?mode=` carries the mode picker (режим работы). Legacy `?agent=` stays
  // readable for old bookmarks — `?mode=` wins when both travel. Both survive
  // F5; the hook itself stays router-free (testable without Next) — sync lives
  // here. Only `usePathname`/`useRouter` are used (no `useSearchParams`, so no
  // Suspense boundary is required); the query string is read from window.location.
  const router = useRouter();
  const pathname = usePathname();
  const readUrlQuery = (): string => {
    if (typeof window === 'undefined') return '';
    return window.location.search.startsWith('?') ? window.location.search.slice(1) : '';
  };

  // Init: `?mode=` (canonical) → picker state, legacy `?agent=` as fallback
  // for old bookmarks (mode wins; fallback DEFAULT_AGENT_ID in the hook).
  useEffect(() => {
    const qs = new URLSearchParams(readUrlQuery());
    // Совместимость: старый `?agent=` остаётся рабочим, новый `?mode=` в приоритете.
    const mode = qs.get('mode') || qs.get('agent');
    if (mode && mode !== chat.modeId) chat.setModeId(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `setModeId` → `?mode=` (replace, no scroll, no history spam; legacy
  // `?agent=` is dropped on write so the URL canonicalizes to `?mode=`).
  useEffect(() => {
    if (!pathname || typeof window === 'undefined') return;
    const next = new URLSearchParams(readUrlQuery());
    const current = next.get('mode') ?? next.get('agent') ?? DEFAULT_AGENT_ID;
    if (chat.modeId === current) return;
    if (chat.modeId === DEFAULT_AGENT_ID) {
      next.delete('mode');
      next.delete('agent');
    } else {
      next.set('mode', chat.modeId);
      // Совместимость записи: каноника — `?mode=`, старый `?agent=` удаляем,
      // чтобы не плодить расходящиеся дубли.
      next.delete('agent');
    }
    const qs = next.toString();
    router.replace(pathname + (qs ? `?${qs}` : ''), { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.modeId, pathname]);

  // Lazy-created session → `.../sessions/[newId]` (replace, history kept in
  // the hook — no page reload, no lost draft).
  useEffect(() => {
    if (!chat.sessionId || !pathname || typeof window === 'undefined') return;
    if (pathname.endsWith(`/${chat.sessionId}`)) return;
    const qs = readUrlQuery();
    const suffix = qs ? `?${qs}` : '';
    if (pathname.endsWith('/sessions')) {
      router.replace(`${pathname}/${chat.sessionId}${suffix}`, { scroll: false });
      return;
    }
    const replaced = pathname.replace(/\/sessions\/[^/]+$/, `/sessions/${chat.sessionId}`);
    if (replaced !== pathname) {
      router.replace(`${replaced}${suffix}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.sessionId, pathname]);

  return (
    <section aria-label={t.chat.title} className={className ? `grid min-h-0 gap-2 ${className}` : 'grid min-h-0 gap-2'}>
      {/* overrides: handlers not in chat + error gate */}
      <ChatThread
        {...chat}
        onSelectLeaf={chat.selectLeaf}
        error={approvalError ?? chat.error}
        onRetry={chat.reload}
        activeModeName={activeModeName}
        onApprove={handleApprove}
        onReject={handleReject}
        approvalPending={approvalPending}
        onFork={setForkMessageId}
        onRevert={setRevertMessageId}
        className={className}
        composerHeight={composerHeight}
      />
      <div ref={composerRef} className={composerClassName}>
        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          sending={chat.sending || aborting}
          leftSlot={
            <ModeSelector
              modeId={chat.modeId}
              onChange={chat.setModeId}
              disabled={chat.sending}
            />
          }
        />
      </div>
      <ChatForkDialog
        open={forkMessageId !== null}
        onOpenChange={(open) => {
          if (!open) setForkMessageId(null);
        }}
        sessionId={chat.sessionId}
        projectId={projectId}
        messageId={forkMessageId}
      />
      <ChatRevertDialog
        open={revertMessageId !== null}
        onOpenChange={(open) => {
          if (!open) setRevertMessageId(null);
        }}
        sessionId={chat.sessionId}
        projectId={projectId}
        messageId={revertMessageId}
      />
    </section>
  );
}
