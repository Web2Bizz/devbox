'use client';

import { useParams } from 'next/navigation';
import { EmptyState } from '@/components/states';
import { useI18n } from '@/i18n';

/**
 * Sessions index page — the list itself lives in the SIDEBAR on every
 * session route (SessionsSidebar → SessionList), so the content block only
 * tells the user to pick a chat. Keeping the list in one place (the aside
 * next to the conversation) removes the double list it used to be.
 */
export default function NestedSessionsPage() {
  const { t } = useI18n();
  const params = useParams();
  const pick = (k: string) => {
    const v = params?.[k];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  };
  const projectId = pick('projectId');

  if (!projectId) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t.sessions.sessionsTitle}</h1>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-semibold">{t.sessions.sessionsTitle}</h1>
      <EmptyState title={t.sessions.pickTitle} description={t.sessions.pickDesc} />
    </div>
  );
}
