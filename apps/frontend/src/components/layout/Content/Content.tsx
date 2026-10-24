'use client';

import type { ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../../states';

export type ContentEmpty = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
};

export type ContentProps = {
  children: ReactNode;
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
}: ContentProps) {
  return (
    <main id="main-content" className="app-content">
      <div className="page-inner">
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
