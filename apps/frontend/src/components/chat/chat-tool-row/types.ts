import type { ChatEntry } from '../../../lib/chat-chain';

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
