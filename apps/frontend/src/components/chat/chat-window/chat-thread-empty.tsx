'use client';

import { EmptyState } from '../../states';
import { useI18n } from '../../../i18n';

export function ChatThreadEmpty() {
  const { t } = useI18n();
  return (
    <div className="flex h-[calc(100dvh_-_9rem)] min-h-[20rem] items-center justify-center px-4 pt-[calc(var(--header-height)_+_1rem)]">
      <EmptyState title={t.chat.emptyTitle} description={t.chat.emptyDesc} />
    </div>
  );
}
