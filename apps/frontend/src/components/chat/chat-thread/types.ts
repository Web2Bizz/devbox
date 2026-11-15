import type { ChatThreadState } from '../../../hooks/useChatTypes';

export type ChatThreadProps = Pick<ChatThreadState, 'entries'> &
  Partial<Omit<ChatThreadState, 'entries'>> & {
  onSelectLeaf?: (leafId: string) => void;
  /** Retry for the toast action — SSE redial + history refetch (owned by the section/hook). */
  onRetry?: () => void;
  /** Display name of the active work mode (never joined with the mode's tool). */
  activeModeName?: string;
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
