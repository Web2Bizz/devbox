'use client';

import { EmptyState } from '../states';
import { useI18n } from '../../i18n';
import type { ChatThreadEmptyProps } from './types';

export function ChatThreadEmpty(_props: ChatThreadEmptyProps) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[20rem] items-center justify-center px-4">
      <EmptyState title={t.chat.emptyTitle} description={t.chat.emptyDesc} />
    </div>
  );
}
