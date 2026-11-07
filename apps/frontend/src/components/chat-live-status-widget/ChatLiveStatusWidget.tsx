'use client';

import { Badge } from '@web2bizz/ui/components';
import { ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../i18n';
import type { ChatLiveStatusWidgetProps } from './types';

/** Live status line: ShimmerText + agent/tool badges (thinking/streaming). */
export function ChatLiveStatusWidget({ mode, activeAgentName, activeToolName }: ChatLiveStatusWidgetProps) {
  const { t } = useI18n();
  const label = mode === 'streaming' ? t.chat.streaming : [activeAgentName, activeToolName].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1" data-testid="chat-streaming-status">
      <ShimmerText>{label}</ShimmerText>
      {activeAgentName ? (
        <Badge variant="secondary">
          {t.chat.activeAgent}: {activeAgentName}
        </Badge>
      ) : null}
      {activeToolName ? (
        <Badge variant="secondary">
          {t.chat.activeTool}: {activeToolName}
        </Badge>
      ) : null}
    </div>
  );
}
