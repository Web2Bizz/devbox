'use client';

import { Badge } from '@web2bizz/ui/components';
import { useI18n } from '../../../i18n';
import { AgentThinking } from './agent-thinking';

export type ChatThinkingRowProps = {
  activeAgentName?: string;
  activeToolName?: string;
};

/** Live "thinking" row: bare ShimmerText line + agent/tool badges. */
export function ChatThinkingRow({ activeAgentName, activeToolName }: ChatThinkingRowProps) {
  const { t } = useI18n();
  return (
    <div data-testid="chat-thinking" aria-busy="true" className="flex flex-wrap items-center gap-2 py-2">
      <AgentThinking activeAgentName={activeAgentName} activeToolName={activeToolName} />
      {activeToolName ? (
        <Badge variant="secondary" data-testid="chat-active-tool">
          {t.chat.activeTool}: {activeToolName}
        </Badge>
      ) : null}
    </div>
  );
}
