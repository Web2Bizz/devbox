import type { ChatToolEvent } from '../../hooks/useChat';

export type ChatToolsTimelineProps = {
  /** Chronological tool calls of the session (append-only, see useChat). */
  events: Array<ChatToolEvent>;
  /** Tool name currently reported by the live part frames (null while idle). */
  liveToolName?: string | null;
};
