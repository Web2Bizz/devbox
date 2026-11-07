export type ChatLiveStatusProps = {
  /** Display name of the agent owning the in-flight turn. */
  activeAgentName?: string;
  /** Tool name reported by the live part frames. */
  activeToolName?: string;
  /** Live thinking active (reasoning frames streaming, never durable). */
  reasoningActive?: boolean;
};
