import type { ChatEntry } from '../../../lib/chat-chain';
import type { ChatApprovalState } from '../../../hooks/useChatTypes';

export type ChatThreadProps = {
  /** Unified chain (required): entries own the order via chain-index. */
  entries: Array<ChatEntry>;
  leafId?: string | null;
  variants?: Array<ChatEntry>;
  variantIndex?: number;
  variantCount?: number;
  onSelectLeaf?: (id: string) => void;
  loading?: boolean;
  sending?: boolean;
  error?: string | null;
  /** Owning session — part of the toast dedup key (survives remount via sessionStorage). */
  sessionId?: string | null;
  /** Retry for the toast action — SSE redial + history refetch (owned by the section/hook). */
  onRetry?: () => void;
  /** Live tool name with no chain row yet (in-flight SSE sidecar). */
  activeAgentName?: string;
  activeToolName?: string;
  /** Approval gate of the parked long-session turn (null when no turn awaits). */
  approval?: ChatApprovalState | null;
  /** Resolve the parked turn (approve resumes, reject parks on paused). */
  onApprove?: () => void;
  onReject?: () => void;
  /** POST /approval in flight — both actions stay disabled. */
  approvalPending?: boolean;
  onFork?: (messageId: string) => void;
  onRevert?: (messageId: string) => void;
  className?: string;
  /** Measured composer height (px) — the jump button floats above it. */
  composerHeight?: number;
};
