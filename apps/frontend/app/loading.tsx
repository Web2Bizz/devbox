'use client';

import { Skeleton } from '@web2bizz/ui/components';
import { useI18n } from '@/i18n';

export default function RootLoading() {
  const { t } = useI18n();
  return (
    <main className="page">
      <div className="page-inner">
        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] items-stretch mb-6" aria-busy="true" aria-label={t.common.loadingPage}>
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      </div>
    </main>
  );
}
