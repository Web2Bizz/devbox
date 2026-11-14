/**
 * Workflows sibling-module types — export type only (&, never interface, CoC root §1).
 */

/** Structural contract of a domain executor answering one chain prompt. */
export type DomainExecutor = {
  ask: (question: string, userId: string, correlationId?: string) => Promise<string>;
};

/** Workflow id: single-answer (one direct answer) vs routed-chain (decompose → steps → synthesize). */
export type AgentWorkflowId = 'single-answer' | 'routed-chain';

/** Picker row of one workflow (id + human labels, definitions only). */
export type WorkflowSummary = {
  id: AgentWorkflowId;
  name: string;
  description: string;
};
