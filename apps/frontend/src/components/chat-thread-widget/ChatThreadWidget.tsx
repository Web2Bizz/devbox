'use client';

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@web2bizz/ui/widgets';
import type { ChatThreadWidgetProps } from './types';

/** Kit scroller shell: anchoring, auto-follow, jump-to-latest. No branches. */
export function ChatThreadWidget({
  children,
  title,
  scrollEndLabel,
  scrollerClassName,
  contentClassName,
  viewportClassName,
}: ChatThreadWidgetProps) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className={scrollerClassName}>
        <MessageScrollerViewport aria-label={title} className={viewportClassName}>
          <MessageScrollerContent className={contentClassName} aria-live="polite">
            {children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton
          direction="end"
          variant="outline"
          size="sm"
          className="absolute right-3 bottom-3"
          aria-label={scrollEndLabel}
        >
          {scrollEndLabel}
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
