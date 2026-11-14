export type ChatLiveStatusProps = {
  /** Display name of the mode owning the in-flight turn (never joined with a tool of the mode). */
  activeModeName?: string;
  /** Live thinking active (reasoning frames streaming, never durable). */
  reasoningActive?: boolean;
};
