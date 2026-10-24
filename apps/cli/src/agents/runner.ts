// agents/runner — dry-run by default, no real mutation without --apply.
// MVP never executes mutations: --apply only acknowledges intent in a box.

import { assertAllowedAgent } from "./allowlist.js";

export type AgentRun = {
  agent: string;
  prompt: string;
  dryRun: boolean;
  message: string;
};

/** Dry-run unless apply is true. Throws on unknown agent (allowlist). */
export function runAgent(agent: string, prompt: string, apply = false): AgentRun {
  const name = assertAllowedAgent(agent.trim());
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) {
    throw new Error("[cli] /agent needs a prompt — usage: /agent <name> <prompt>.");
  }
  if (!apply) {
    return {
      agent: name,
      prompt: cleanPrompt,
      dryRun: true,
      message: `dry-run: would invoke @${name} with ${JSON.stringify(cleanPrompt)} (pass --apply to execute, no mutations in MVP).`,
    };
  }
  return {
    agent: name,
    prompt: cleanPrompt,
    dryRun: false,
    message: `--apply acknowledged for @${name} (MVP still performs no mutations; wire the executor here).`,
  };
}
