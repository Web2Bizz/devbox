export type ChatStreamingRowProps = {
  streamingText: string;
  activeAgentName?: string;
  activeToolName?: string;
  reasoningText?: string;
  /** Last timeline line shown when reasoningText is empty (no mute shimmer). */
  fallbackText?: string | null;
};
