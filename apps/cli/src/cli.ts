#!/usr/bin/env bun
// cli entry — arg parsing + REPL loop. All output via process.stdout (no console.*).
// TTY REPL renders through the transparent OpenTUI layer (commands/runners.ts); every
// other route (--help, non-TTY, CI) keeps the stdout fallback below.
import { createRequire } from "node:module";
import { errorText, headerText } from "./ui/shared/plain.js";
import { helpText } from "./prompt/repl.js";
import { cmdAgentList, cmdAgentRun, cmdResolve } from "./commands/index.js";
import { startRepl } from "./commands/interactive.js";
import { out, stdoutSink } from "./commands/sinks.js";

const pkgRequire = createRequire(import.meta.url);
export const VERSION: string = (pkgRequire("../package.json") as { version: string }).version;

export function showHelp(): void {
  out(headerText("DEVBOX CLI — help"));
  out(["usage: cli [--help] [--version] [agent list] [resolve @ref]", "repl: /help /exit /agent list /agent <name> <prompt> [@ref]", ...helpText().split("\n")].join("\n"));
}

export function showVersion(): void {
  out(`✓ devbox cli v${VERSION}`);
}

// Note: non-REPL routes (help/version/agent/resolve/unknown) and the
// !isTTY fallback never clear — showHelp() writes directly, no clear.

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }
  if (args.includes("--version") || args.includes("-V")) {
    showVersion();
    return;
  }
  if (args[0] === "agent" && args[1] === "list") {
    await cmdAgentList(stdoutSink);
    return;
  }
  if (args[0] === "agent" && args[1] === "run" && typeof args[2] === "string" && args[2]) {
    const agentName: string = args[2];
    const apply = args.includes("--apply");
    const prompt = args.slice(3).filter((a) => a !== "--apply").join(" ").trim();
    if (!prompt) {
      out(errorText("[cli] agent run needs a prompt — usage: cli agent run <name> <prompt> [--apply].", "Try /agent list."));
      process.exitCode = 1;
      return;
    }
    await cmdAgentRun(stdoutSink, agentName, prompt, apply);
    return;
  }
  if (args[0] === "resolve" && typeof args[1] === "string" && args[1]) {
    const raw: string = args[1];
    await cmdResolve(stdoutSink, raw);
    return;
  }
  if (args.length > 0 && args[0] !== "repl") {
    out(errorText(`[cli] unknown args ${JSON.stringify(args.join(" "))} — try cli --help.`, "cli agent list | cli resolve @path | cli repl"));
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    showHelp();
    return;
  }
  startRepl(VERSION);
}

await main();
