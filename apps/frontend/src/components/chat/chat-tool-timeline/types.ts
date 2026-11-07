import type { ChatToolEvent } from '../../../hooks/useChat';

export type ChatToolTimelineProps = {
  /** Chronological tool calls of the session (append-only, see useChat). */
  events: ChatToolEvent[];
  /** Tool name currently reported by the live part frames (null while idle). */
  liveToolName?: string | null;
};
