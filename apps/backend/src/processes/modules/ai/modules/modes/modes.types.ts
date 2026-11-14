import type { AgentWorkflowId } from '../workflows/workflows.types';

/**
 * Modes sibling-module types — export type only (&, never interface, CoC root §1).
 *
 * A work MODE ('ask' | 'auto') is a selector: it chooses which WORKFLOW runs.
 * It is NOT an agent: the same wire strings ('ask' / 'auto') also identify
 * the AskAgent / AutoAgent EXECUTORS, but modes live in `ai/modules/modes/`
 * while executors live in the sibling `ai/modules/agents/` layer — different
 * modules, different types (`AgentWorkMode` vs the executors' own ids), one
 * mapping between them.
 */

/** Work mode selector: which workflow the turn runs (NOT an agent id). */
export type AgentWorkMode = 'ask' | 'auto';

/** Mode → workflow mapping (the selector decision). */
export type ModeSelection = {
  mode: AgentWorkMode;
  workflow: AgentWorkflowId;
};

/** Picker row of one mode: the selection plus its human description. */
export type ModeEntry = ModeSelection & {
  description: string;
};
