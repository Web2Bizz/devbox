'use client';

import { useParams } from 'next/navigation';
import { ChatSection } from '@/features/chat/chat-section';

export default function NestedSessionPage() {
  const params = useParams();
  const pick = (k: string) => {
    const v = params?.[k];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  };
  const sessionId = pick('sessionId');
  const projectId = pick('projectId');

  if (!sessionId) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Session</h1>
      </div>
    );
  }

  return <ChatSection sessionId={sessionId} projectId={projectId} />;
}
