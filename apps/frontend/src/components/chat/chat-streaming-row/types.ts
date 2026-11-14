export type ChatStreamingRowProps = {
  streamingText: string;
  activeAgentName?: string;
  /**
   * Deprecated (single thinking source lives in `ChatThinkingRow`): kept
   * for call-site compat, never rendered here — no second Thinking.
   */
  reasoningText?: string;
  /** Deprecated: ignored, see `reasoningText`. */
  fallbackText?: string | null;
};
