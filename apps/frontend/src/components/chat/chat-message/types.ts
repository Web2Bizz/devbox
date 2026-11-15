import type { ChatMessage } from '../../../hooks/useChatTypes';

export type ChatMessageRowProps = {
  message: ChatMessage;
  onFork?: (messageId: string) => void;
  onRevert?: (messageId: string) => void;
  onRevertMessages?: (messageId: string) => void;
  onRetry?: (messageId: string) => void;
};
