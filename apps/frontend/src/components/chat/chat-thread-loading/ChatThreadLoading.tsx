'use client';

import { ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../../i18n';
import type { ChatThreadLoadingProps } from './types';

/**
 * Thread loading placeholder — kit `ShimmerText` live line (0.26.5
 * `widgets`), same shimmer primitive as the sending/streaming statuses
 * (`ChatLiveStatus`, `ChatThinkingRow`). No `Skeleton` blocks: the thread
 * resolves into text/tool rows, so the placeholder is a single shimmer
 * line, not card-shaped boxes. Flat per DESIGN.md §7 — kit tokens only.
 */
export function ChatThreadLoading(_props: ChatThreadLoadingProps) {
  const { t } = useI18n();
  return (
    <div className="grid auto-rows-min content-start gap-2 self-start px-1 pt-[calc(var(--header-height)_+_1rem)]" aria-busy="true" aria-label={t.common.loadingPage}>
      <ShimmerText>{t.common.loadingPage}</ShimmerText>
    </div>
  );
}
