export type ChatThinkingRowProps = {
  activeAgentName?: string;
  activeToolName?: string;
  reasoningText?: string;
  /** Explicit live status when thinking trace is empty (timeline fallback). */
  reasoningActive?: boolean;
  /** Last timeline line shown when reasoningText is empty (no mute shimmer). */
  fallbackText?: string | null;
};
