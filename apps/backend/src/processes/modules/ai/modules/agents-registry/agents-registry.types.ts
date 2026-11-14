/** Agent registry contracts (ai/modules/agents-registry). */

/** How an agent participates in a chat turn (primary picker vs subagent job). */
export type AgentMode = 'primary' | 'subagent';

/** Registry row of one agent (definitions only, no transport). */
export type AgentDefinition = {
  id: string;
  name: string;
  description: string;
  /** Hidden agents answer only through a parent agent / subagent job. */
  hidden: boolean;
  /** Subagent-mode rows are never offered by the chat picker. */
  mode: AgentMode;
};

/** Default agent when no id travels (the server's own default, not guessed). */
export const DEFAULT_AGENT_ID: 'ask' = 'ask';
