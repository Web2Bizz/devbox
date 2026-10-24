'use client';

import { Skeleton } from '@web2bizz/ui/components';
import { useI18n } from '@/i18n';

export default function RootLoading() {
  const { t } = useI18n();
  return (
    <main className="page">
      <div className="page-inner">
        <div className="status-grid" aria-busy="true" aria-label={t.common.loadingPage}>
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      </div>
    </main>
  );
}
