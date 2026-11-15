import { ChatSection } from '@/features/chat-section';
import { SESSION_COMPOSER_CLASSNAME, SESSION_THREAD_CLASSNAME } from './layout';

type SessionChatPageParams = {
  orgId: string;
  projectId: string;
  sessionId: string;
};

export default async function SessionChatPage({
  params,
}: {
  params: Promise<SessionChatPageParams>;
}) {
  const { sessionId, projectId } = await params;

  if (!sessionId) {
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Session</h1>
      </div>
    );
  }

  return (
    <ChatSection
      sessionId={sessionId}
      projectId={projectId}
      className={SESSION_THREAD_CLASSNAME}
      composerClassName={SESSION_COMPOSER_CLASSNAME}
    />
  );
}
