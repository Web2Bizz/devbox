import type { ChatMessage } from '../../../hooks/useChat';

export type ChatMessageRowProps = {
  message: ChatMessage;
  onFork?: (messageId: string) => void;
  onRevert?: (messageId: string) => void;
};
