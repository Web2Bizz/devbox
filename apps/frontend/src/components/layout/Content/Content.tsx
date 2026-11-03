'use client';

import type { ReactNode } from 'react';
import { cn } from '@web2bizz/ui/utils';
import { EmptyState, ErrorState, LoadingState } from '../../states';

export type ContentEmpty = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
};

export type ContentVariant = 'default' | 'chat';

export type ContentProps = {
  children: ReactNode;
  /**
   * Layer variant. `chat` — the chat layer only: the panel stretches over
   * the FULL vertical range of the shell (grid rows 1..-1), sliding under
   * the Header (Header keeps `z-30`, panel stays `z-0`), and its inner
   * padding is pushed down by `--header-height` so the conversation never
   * hides behind the bar. Every other page keeps `default`.
   */
  variant?: ContentVariant;
  /** When true — LoadingState skeleton grid (from states.tsx). */
  isLoading?: boolean;
  loadingRows?: number;
  /** Non-empty string — ErrorState alert (from states.tsx). */
  error?: string | null;
  errorTitle?: string;
  errorRetryLabel?: string;
  onRetry?: () => void;
  /** When true + `empty` provided — EmptyState card (from states.tsx). */
  isEmpty?: boolean;
  empty?: ContentEmpty;
};

/**
 * Full-width page content: semantic <main> + full-width .page-inner
 * (width 100%, max-width none, margin 0, padding 1.5rem 1rem like .app-sidebar). Loading/error/empty slots from states.tsx;
 * pass-through by default so pages handling their own states keep working
 * with zero visual regression. Shell usage: `<Content>{children}</Content>`.
 */
export function Content({
  children,
  isLoading = false,
  loadingRows = 3,
  error = null,
  errorTitle,
  errorRetryLabel,
  onRetry,
  isEmpty = false,
  empty,
  variant = 'default',
}: ContentProps) {
  return (
    <main
      id="main-content"
      data-content=""
      data-content-variant={variant}
      className={cn(
        'w-full h-full min-w-0 min-h-0 overflow-x-clip overflow-y-auto overscroll-contain',
        // Chat layer: `grid-area` is emitted as a whole (never layered on top
        // of the named area) — the panel takes column 2 and BOTH rows
        // (header row included) and stays under the bar (Header is z-30).
        // Only the panel height changes; its column/width stays the same.
        // Chat has NO panel chrome (no border, no background — the thread
        // and the fixed composer float directly on the page); every other
        // page keeps the bordered `bg-background` card.
        variant === 'chat'
          ? 'z-0 border-0 bg-transparent [grid-area:1/2/-1/3]'
          : 'grid-area-[content] border border-border rounded-[var(--radius-xl)] bg-background',
      )}
    >
      <div
        className={cn(
          'w-full max-w-none m-0 px-4 box-border',
          // Chat: the panel box goes edge-to-edge (under the Header —
          // Header is z-30 above it); the thread itself clears the bar
          // with its own top padding inside the scroller (see ChatWindow),
          // so the first message never hides behind the bar.
          variant === 'chat'
            ? 'pt-2 pb-2'
            : 'py-6',
        )}
      >
        {isLoading ? (
          <LoadingState rows={loadingRows} />
        ) : error ? (
          <ErrorState
            message={error}
            onRetry={onRetry}
            title={errorTitle}
            retryLabel={errorRetryLabel}
          />
        ) : isEmpty && empty ? (
          <EmptyState
            title={empty.title}
            description={empty.description}
            actionLabel={empty.actionLabel}
            onAction={empty.onAction}
          />
        ) : (
          children
        )}
      </div>
    </main>
  );
}
