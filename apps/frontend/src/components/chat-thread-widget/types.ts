import type { ReactNode } from 'react';

export type ChatThreadWidgetProps = {
  children: ReactNode;
  title: string;
  scrollEndLabel: string;
  scrollerClassName?: string;
  contentClassName?: string;
  viewportClassName?: string;
};
