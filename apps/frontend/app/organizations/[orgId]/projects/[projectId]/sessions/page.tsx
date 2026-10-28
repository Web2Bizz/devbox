'use client';

import { useParams } from 'next/navigation';
import { SessionsTab } from '@/components/projects/sessions-tab/sessions-tab';

export default function NestedSessionsPage() {
  const params = useParams();
  const pick = (k: string) => {
    const v = params?.[k];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  };
  const orgId = pick('orgId');
  const projectId = pick('projectId');

  if (!orgId || !projectId) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Sessions</h1>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-semibold">Sessions</h1>
      <SessionsTab projectId={projectId} orgId={orgId} />
    </div>
  );
}
