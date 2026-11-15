import type { AgentDefinition } from '../agents-registry/agents-registry.types';

/**
 * Subagent sibling-module types — export type only (&, never interface, CoC root §1).
 *
 * A subagent runs as an encapsulated job: the parent hands a prompt in and
 * receives a `ToolSettlement` back (no transport handle, no session
 * mutations). The job needs the executors layer (ask + resolve) only through
 * the `SubagentAgentFacade` surface below: the value edge is the DI token
 * bound in SubagentModule (useFactory on AgentsService/AgentsRegistryService
 * via forwardRef), so the agents↔subagent module link is forwardRef-only
 * (type-only edge down is allowed).
 */

/** One subagent job: which agent answers, the prompt and its owner. */
export type SubagentJobRequest = {
  agentId: string;
  prompt: string;
  userId: string;
  correlationId?: string;
  /** Call id of the parent tool call (settlement correlation). */
  callID?: string;
};

/** Picker row of one subagent-capable executor (hidden domain agent). */
export type SubagentExecutorSummary = {
  id: string;
  name: string;
  description: string;
};

/** Minimal executors-layer surface a subagent job needs (bound in SubagentModule). */
export type SubagentAgentFacade = {
  askQuestion: (
    agentId: string,
    prompt: string,
    userId: string,
    correlationId?: string,
  ) => Promise<string>;
  resolve: (agentId?: string) => AgentDefinition;
  listAll: () => Array<AgentDefinition>;
};

/** DI token binding the facade (bound in SubagentModule, forwardRef to AgentsModule). */
export const SUBAGENT_AGENT_FACADE: unique symbol = Symbol('SubagentAgentFacade');
