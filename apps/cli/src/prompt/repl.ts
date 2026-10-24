// prompt/repl — line parser only (no readline here, keeps layers testable).
// Commands: /help, /exit, /quit, /agent list, /agent <name> <prompt>.
// Free text may carry @refs (resolved by the caller via core/queries/refs/resolve).
// Startup helpers (clear + TTY gate) live here so tests can assert order
// without importing cli.ts (which runs main() on import).

import { assertAllowedAgent, listAgents } from "../agents/allowlist.js";
import { runAgent } from "../agents/runner.js";
import { extractRefs } from "../core/queries/refs/resolve.js";

// Full-screen reset (ESC c). Written via process.stdout.write only.
// Value equals ESC+c (27 + c); built without raw ESC byte to keep source ASCII.
export const CLEAR_SEQUENCE: string = String.fromCharCode(27) + "c";

// REPL input label — always the last visible line (prompt stays bottom).
// Retained + tested pure contract (no production callers in TUI-only flows).
export const PROMPT_LABEL = "prompt > ";

// Clear only on interactive TTY (never --help/CI !isTTY paths).
export function shouldClearScreen(isTTY: boolean): boolean {
  return isTTY;
}

// True when args would enter the REPL (mirrors cli.ts main routing).
export function shouldStartRepl(args: string[], isTTY: boolean): boolean {
  if (!isTTY) return false;
  if (args.includes("--help") || args.includes("-h")) return false;
  if (args.includes("--version") || args.includes("-V")) return false;
  if (args.length === 0) return true;
  if (args.length === 1 && args[0] === "repl") return true;
  return false;
}

// True when REPL startup must clear first (TTY + REPL route).
export function shouldClearForRepl(args: string[], isTTY: boolean): boolean {
  return shouldStartRepl(args, isTTY) && shouldClearScreen(isTTY);
}

// Write the clear sequence (no console.clear — keeps tests hermetic).
export function clearScreen(write: (chunk: string) => void = (s: string) => void process.stdout.write(s)): void {
  write(CLEAR_SEQUENCE);
}

// Hint lines shown above the prompt at startup (history stays on top).
export function startupHintLines(): string[] {
  return ["type /help for commands, /exit to leave", "refs: @path/to/file (REPOS_ROOT jail, \"..\" denied)"];
}

export type ParsedLine =
  | { kind: "help" }
  | { kind: "exit" }
  | { kind: "agent-list" }
  | { kind: "agent-run"; agent: string; prompt: string; apply: boolean }
  | { kind: "prompt"; text: string; refs: string[] }
  | { kind: "empty" };

export function parseLine(input: string): ParsedLine {
  const line = input.trim();
  if (!line) return { kind: "empty" };
  if (line === "/help" || line === "/h" || line === "?") return { kind: "help" };
  if (line === "/exit" || line === "/quit" || line === "/q") return { kind: "exit" };
  if (line === "/agent list" || line === "/agents") return { kind: "agent-list" };
  if (line.startsWith("/agent ")) {
    const rest = line.slice("/agent ".length).trim();
    const applySuffix = rest.endsWith(" --apply");
    const body = applySuffix ? rest.slice(0, -" --apply".length).trim() : rest;
    const space = body.indexOf(" ");
    if (space === -1) {
      if (!body) throw new Error("[cli] usage: /agent <name> <prompt> (or /agent list).");
      assertAllowedAgent(body);
      throw new Error(`[cli] /agent ${body} needs a prompt — usage: /agent ${body} <prompt>.`);
    }
    const name = body.slice(0, space).trim();
    const prompt = body.slice(space + 1).trim();
    assertAllowedAgent(name);
    // Validate eagerly so typos fail fast even before resolve.
    runAgent(name, prompt || "x", true);
    if (!prompt) throw new Error(`[cli] /agent ${name} needs a prompt.`);
    return { kind: "agent-run", agent: name, prompt, apply: applySuffix };
  }
  if (line.startsWith("/")) {
    throw new Error(`[cli] unknown command ${JSON.stringify(line)} — try /help.`);
  }
  return { kind: "prompt", text: line, refs: extractRefs(line) };
}

export function helpText(): string {
  const agents = listAgents()
    .map((a) => `  /agent ${a.name} <prompt> — ${a.description}`)
    .join("\n");
  return [
    "commands:",
    "  /help — this help",
    "  /exit — leave the REPL",
    "  /agent list — show the allowlist",
    agents,
    "  @path/to/file — resolve inside REPOS_ROOT (\"..\" denied, read-only)",
    "flags: --apply (agent run via OpenCode; without it dry-run shows what would go)",
    "key: auth.json only ($HOME/.local/share/opencode/auth.json,",
    "  XDG_DATA_HOME override); env key vars are NOT read — вставь через /connect,",
    "  missing key → fail-fast, see .env.example.",
  ].join("\n");
}
