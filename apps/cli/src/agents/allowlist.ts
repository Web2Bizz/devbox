// agents/allowlist — static allowlist mirroring .opencode/agents (no fs at runtime).
// Only these agents may be referenced by /agent. Anything else → error box.

export type AgentName =
  | "ask"
  | "plan"
  | "build"
  | "build-fast"
  | "build-smart"
  | "refactor"
  | "unit-test"
  | "review"
  | "diagnostics"
  | "task-manager"
  | "devops";

export const AGENT_ALLOWLIST: ReadonlyArray<{ name: AgentName; description: string }> = [
  { name: "ask", description: "readonly answers over the codebase" },
  { name: "plan", description: "step-by-step implementation plan" },
  { name: "build", description: "default code executor (simple tasks)" },
  { name: "build-fast", description: "fast executor for low-complexity tasks" },
  { name: "build-smart", description: "smart executor for medium/high complexity" },
  { name: "refactor", description: "update/delete/decompose via module-develop" },
  { name: "unit-test", description: "writes unit tests only (no source edits)" },
  { name: "review", description: "quality gate over the diff (no edits)" },
  { name: "diagnostics", description: "failure triage: recon then culprit" },
  { name: "task-manager", description: "Trello cards via scripts (no code)" },
  { name: "devops", description: "infra/deploy only (escalation target)" },
];

export function isAllowedAgent(name: string): name is AgentName {
  return AGENT_ALLOWLIST.some((a) => a.name === name);
}

export function listAgents(): Array<{ name: string; description: string }> {
  return AGENT_ALLOWLIST.map((a) => ({ name: a.name, description: a.description }));
}

export function assertAllowedAgent(name: string): AgentName {
  if (!isAllowedAgent(name)) {
    const known = AGENT_ALLOWLIST.map((a) => a.name).join(", ");
    throw new Error(`[cli] unknown agent ${JSON.stringify(name)} — allowlist: ${known}.`);
  }
  return name;
}
