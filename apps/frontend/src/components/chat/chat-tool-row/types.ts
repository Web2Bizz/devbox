import type { ChatEntry } from '../../../lib/chat-chain';
import type { ChatToolEvent } from '../../../hooks/useChatTypes';

export type { ChatToolEvent };

export type ChatToolRowProps = {
  /**
   * Unified chain tool entry (durable REST + live SSE share the
   * same `ChatEntry` type, reload parity before/after). Rendered as one
   * flat row in parentId order — no grouping, no timeline block.
   */
  entry?: ChatEntry;
  /**
   * Live tool name that has no chain row yet (the closing live row of the
   * thread, ShimmerText while the call is in flight).
   */
  liveToolName?: string;
};

/**
 * Flat tool-row status (WEB-21/D3, Claude/Cursor-style timeline).
 *
 * Domain vocabulary from `session_messages` (`status`/`detail`):
 * `running` = in-flight (`called`/`progress`/`started`/`thinking`/
 * free-text snippets), `done` = terminal success, `error` = terminal
 * failure. There is no `warning` row — review-gated steps are still open,
 * hence `running`.
 */
export type ToolRowStatus = 'running' | 'done' | 'error';
