'use client';

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@web2bizz/ui/widgets';
import { Alert, AlertDescription, AlertTitle, Button } from '@web2bizz/ui/components';
import { ErrorState } from '../../states';
import { useI18n } from '../../../i18n';
import { ChatMessageRow } from '../chat-message';
import { ChatToolRow } from '../chat-tool-row';
import { formatVisibleFallback } from '../chat-tool-timeline';
import { ChatThinkingRow } from '../chat-thinking-row';
import { ChatThreadEmpty } from '../chat-thread-empty';
import { ChatThreadLoading } from '../chat-thread-loading';
import { buildThreadRows, isTextEntry, isToolEntry, toChatMessages } from '../../../lib/chat-chain';
import type { ChatThreadProps } from './types';

/**
 * Thread widget: ONE render over the unified chain.
 * `entries` + `leafId` (chain-index via `buildThreadRows`) own the order —
 * the single source for durable text and live tool sidecar rows (reload
 * parity: the same `ChatEntry` type renders identically before/after).
 * Message/tool rows interleave in parentId order — no separate timeline block.
 * Live terminator: the thinking row closes the chain as the kit scroll
 * anchor while `sending` (live SSE sidecar: `activeToolName` has no chain
 * row yet). Thinking has ONE source (`ChatThinkingRow`).
 * Branch switcher is navigation-only (prev/next) and renders only with
 * explicit variants + onSelectLeaf.
 */
export function ChatThread({
  entries,
  leafId,
  variants,
  variantIndex,
  variantCount,
  onSelectLeaf,
  loading = false,
  sending = false,
  error = null,
  activeAgentName,
  activeToolName,
  approval = null,
  onApprove,
  onReject,
  approvalPending = false,
  onFork,
  onRevert,
  className,
  composerHeight = 0,
}: ChatThreadProps) {
  const { t } = useI18n();
  // Single chain-index source: entries own the order (no legacy fallback).
  const thread = buildThreadRows(entries, leafId);
  const chain = thread.chain;
  const visibleText = toChatMessages(chain);
  const switcherCount = variantCount ?? variants?.length ?? 0;
  const switcherIndex = variantIndex ?? 0;
  const showSwitcher =
    switcherCount > 1 && variants !== undefined && onSelectLeaf !== undefined;
  const thinking = sending;
  const hasReasoningEntry = chain.some(
    (entry) => entry.kind === 'tool' && entry.name === 'reasoning',
  );
  const reasoningActive = hasReasoningEntry;
  // Single thinking fallback: last chain tool line via the shared formatter
  // (no mute shimmer, no raw transport). Never invents content.
  const chainEvents = chain.filter(isToolEntry).map((tool) => ({
    id: tool.id,
    at: tool.at,
    kind: (tool.name === 'reasoning' ? 'reasoning' : 'tool') as 'tool' | 'reasoning',
    label: tool.name,
    ...((tool.detail ?? tool.status) ? { detail: tool.detail ?? tool.status } : {}),
  }));
  const fallbackText = formatVisibleFallback(chainEvents, t);

  if (loading && visibleText.length === 0 && !sending && !hasReasoningEntry && !error) {
    return <ChatThreadLoading />;
  }

  if (error && visibleText.length === 0 && !sending && !hasReasoningEntry && !thinking) {
    return (
      <div className="min-h-[20rem] px-1 pt-[calc(var(--header-height)_+_1rem)]">
        <ErrorState message={error} />
      </div>
    );
  }

  if (visibleText.length === 0 && !sending && !hasReasoningEntry && !thinking) {
    return <ChatThreadEmpty />;
  }

  return (
    <div className={className ? `grid min-h-0 gap-2 ${className}` : 'grid min-h-0 gap-2'}>
      {error ? <ErrorState message={error} /> : null}
      {approval ? (
        <Alert data-testid="chat-approval-banner">
          <AlertTitle>{t.chat.approvalTitle}</AlertTitle>
          <AlertDescription>{approval.reason}</AlertDescription>
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="chat-approval-approve"
              disabled={approvalPending}
              onClick={onApprove}
            >
              {t.chat.approvalContinue}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="chat-approval-reject"
              disabled={approvalPending}
              onClick={onReject}
            >
              {t.chat.stop}
            </Button>
          </div>
        </Alert>
      ) : null}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="h-full min-h-0">
          <MessageScrollerViewport aria-label={t.chat.title} className="min-h-0 px-1">
            <MessageScrollerContent className="gap-1 pt-[calc(var(--header-height)_+_1rem)] pb-36" aria-live="polite">
              {chain.map((entry) =>
                isTextEntry(entry) ? (
                  <MessageScrollerItem key={entry.id} messageId={entry.id}>
                    <ChatMessageRow
                      message={{ id: entry.id, role: entry.role, text: entry.text }}
                      onFork={onFork}
                      onRevert={onRevert}
                    />
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem key={entry.id} messageId={entry.id}>
                    <ChatToolRow entry={entry} />
                  </MessageScrollerItem>
                ),
              )}
              {showSwitcher ? (
                <MessageScrollerItem messageId="chat-branch-switcher">
                  <div
                    data-testid="chat-branch-switcher"
                    className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
                  >
                    <button
                      type="button"
                      data-testid="chat-branch-prev"
                      disabled={switcherIndex <= 0}
                      onClick={() => {
                        const prev = variants?.[switcherIndex - 1];
                        if (prev) onSelectLeaf?.(prev.id);
                      }}
                    >
                      ‹
                    </button>
                    <span data-testid="chat-branch-count">
                      {switcherIndex + 1} / {switcherCount}
                    </span>
                    <button
                      type="button"
                      data-testid="chat-branch-next"
                      disabled={switcherIndex >= switcherCount - 1}
                      onClick={() => {
                        const next = variants?.[switcherIndex + 1];
                        if (next) onSelectLeaf?.(next.id);
                      }}
                    >
                      ›
                    </button>
                  </div>
                </MessageScrollerItem>
              ) : null}
              {activeToolName ? (
                <MessageScrollerItem messageId="chat-tool-live">
                  <ChatToolRow liveToolName={activeToolName} />
                </MessageScrollerItem>
              ) : null}
              {thinking && (
                <MessageScrollerItem messageId="chat-thinking" scrollAnchor>
                  <div data-testid="chat-chain-terminator">
                    <ChatThinkingRow activeAgentName={activeAgentName} reasoningActive={reasoningActive} fallbackText={fallbackText} />
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" variant="outline" size="sm" className="absolute data-[direction=end]:bottom-[128px]" style={composerHeight > 0 ? { bottom: composerHeight + 20 } : undefined} aria-label={t.chat.scrollToEnd}>
            {t.chat.scrollToEnd}
          </MessageScrollerButton>
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
