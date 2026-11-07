'use client';

import { Skeleton } from '@web2bizz/ui/components';
import { useI18n } from '../../i18n';
import type { ChatThreadLoadingProps } from './types';

export function ChatThreadLoading(_props: ChatThreadLoadingProps) {
  const { t } = useI18n();
  return (
    <div className="grid gap-2 px-1" aria-busy="true" aria-label={t.common.loadingPage}>
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  );
}
