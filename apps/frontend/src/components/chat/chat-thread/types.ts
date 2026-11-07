import type { ChatMessage, ChatToolEvent } from '../../../hooks/useChat';

export type ChatThreadProps = {
  messages: Array<ChatMessage>;
  streamingText: string;
  reasoningText?: string;
  loading?: boolean;
  sending?: boolean;
  error?: string | null;
  onRetry?: () => void;
  toolTrace?: Array<ChatToolEvent>;
  activeAgentName?: string;
  activeToolName?: string;
  onFork?: (messageId: string) => void;
  onRevert?: (messageId: string) => void;
  className?: string;
  /** Measured composer height (px) — the jump button floats above it. */
  composerHeight?: number;
};
