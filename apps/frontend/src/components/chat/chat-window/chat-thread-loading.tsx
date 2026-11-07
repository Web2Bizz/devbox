'use client';

import { Skeleton } from '@web2bizz/ui/components';
import { useI18n } from '../../../i18n';

export function ChatThreadLoading() {
  const { t } = useI18n();
  return (
    <div className="grid auto-rows-min content-start gap-2 self-start px-1 pt-[calc(var(--header-height)_+_1rem)]" aria-busy="true" aria-label={t.common.loadingPage}>
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  );
}
