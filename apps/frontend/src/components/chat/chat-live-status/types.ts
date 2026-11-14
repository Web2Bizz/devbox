export type ChatLiveStatusProps = {
  /** Display name of the agent owning the in-flight turn (never joined with a tool). */
  activeAgentName?: string;
  /** Live thinking active (reasoning frames streaming, never durable). */
  reasoningActive?: boolean;
};
