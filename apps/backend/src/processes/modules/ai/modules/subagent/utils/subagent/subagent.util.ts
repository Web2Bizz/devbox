import type { ToolSettlement } from '../../../tool-runtime/tool-runtime.types';

/** Wire name of a subagent call (parent tool-call correlation). */
export function buildSubagentCallName(agentId: string): string {
  return `subagent.${agentId}`;
}

/** Success settlement of a finished subagent job (answer travels as result). */
export function buildSubagentSettlement(
  callID: string,
  agentId: string,
  result: string,
): ToolSettlement {
  const name: string = buildSubagentCallName(agentId);
  return { callID, name, result };
}

/** Failure settlement of a crashed subagent job (never throws outward). */
export function buildSubagentErrorSettlement(
  callID: string,
  agentId: string,
  error: unknown,
): ToolSettlement {
  const name: string = buildSubagentCallName(agentId);
  const result: string = `error: ${error instanceof Error ? error.message : 'subagent failed'}`;
  return { callID, name, result };
}
