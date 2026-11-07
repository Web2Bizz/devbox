'use client';

import { ErrorState } from '../states';
import type { ChatErrorBannerProps } from './types';

/** Terminal/banner error above the thread (system message, Alert allowed). */
export function ChatErrorBanner({ message, onRetry, retryLabel }: ChatErrorBannerProps) {
  if (!message) return null;
  return <ErrorState message={message} onRetry={onRetry} retryLabel={retryLabel} />;
}
