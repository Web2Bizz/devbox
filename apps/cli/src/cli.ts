#!/usr/bin/env bun
// cli entry — arg parsing + REPL loop. All output via process.stdout (no console.*).
// TTY REPL renders through the transparent OpenTUI layer (ui/tui.ts); every
// other route (--help, non-TTY, CI) keeps the stdout fallback below.

import { createInterface } from "node:readline";
import { box, errorBox, greeting, header, okBox, separator, statusLine, table } from "./ui/box.js";
import { spinnerLine } from "./ui/spinner.js";
import { shouldUseTui, startTuiRepl, type TuiSession } from "./ui/tui.js";
import { clearScreen, helpText, parseLine, PROMPT_LABEL, startupHintLines } from "./prompt/repl.js";
import { getReposRoot, resolveRef } from "./refs/resolve.js";
import { listAgents } from "./agents/allowlist.js";
import { runAgent } from "./agents/runner.js";
import { chatLocal } from "./agents/opencode.js";

const VERSION = "0.1.0";

function out(text: string): void {
  process.stdout.write(text + "\n");
}

/** Output sink: stdout REPL writes directly, TUI REPL appends to history. */
type LineSink = {
  emit: (text: string) => void;
  /** Animated in TUI; a static one-shot line on stdout. Returns a stop fn. */
  spin: (label: string) => () => void;
};

const stdoutSink: LineSink = {
  emit: out,
  spin: (label: string) => {
    out(spinnerLine(0, label));
    return () => {};
  },
};

function tuiSink(session: TuiSession): LineSink {
  return {
    emit: (text: string) => session.print(text),
    spin: (label: string) => session.spin(label),
  };
}

function showHelp(): void {
  out(header("DEVBOX CLI — help"));
  out(box(["usage: cli [--help] [--version] [agent list] [resolve @ref]", "repl: /help /exit /agent list /agent <name> <prompt> [@ref]", ...helpText().split("\n")]));
}

function showVersion(): void {
  out(okBox([`devbox cli v${VERSION}`]));
}

async function cmdAgentList(sink: LineSink): Promise<void> {
  const agents = listAgents();
  sink.emit(header("agents — allowlist (dry-run by default)"));
  sink.emit(table(["agent", "description"], agents.map((a) => [a.name, a.description])));
}

async function cmdResolve(sink: LineSink, rawRef: string): Promise<void> {
  const ref = rawRef.startsWith("@") ? rawRef.slice(1) : rawRef;
  const stop = sink.spin(`resolving ${ref} …`);
  try {
    const root = getReposRoot();
    const resolved = await resolveRef(ref, root);
    sink.emit(header(`@ref ${resolved.rel}`));
    sink.emit(box([resolved.isDir ? "(directory)" : `(file) ${resolved.rel}`, separator(76), ...resolved.preview.split("\n").slice(0, 30)]));
  } catch (err) {
    sink.emit(errorBox(err instanceof Error ? err.message : String(err), "Set REPOS_ROOT in your .env (see .env.example)."));
  } finally {
    stop();
  }
}

async function cmdAgentRun(sink: LineSink, name: string, prompt: string, apply: boolean): Promise<void> {
  try {
    const run = runAgent(name, prompt, apply);
    if (run.dryRun) {
      sink.emit(header(`agent @${run.agent} (dry-run)`));
      sink.emit(
        box([
          statusLine("run", run.message),
          `prompt: ${run.prompt}`,
          "hint: без --apply ответа нет — re-run with --apply (cloud: нужен ключ в auth.json).",
        ]),
      );
      return;
    }
    sink.emit(header(`agent @${run.agent} (--apply)`));
    const stop = sink.spin(`asking opencode @${run.agent} …`);
    try {
      const reply = await chatLocal(run.prompt);
      if (!reply.trim() || /^(answer|reply)$/i.test(reply.trim())) {
        throw new Error("[cli] opencode cloud returned an empty reply (shape mismatch).");
      }
      sink.emit(box([statusLine("ok", `reply from @${run.agent}`), separator(76), ...reply.split("\n").slice(0, 30)]));
    } catch (err) {
      sink.emit(errorBox(err instanceof Error ? err.message : String(err), "Вставь ключ через /connect в TUI (см. apps/cli/.env.example, OPENCODE_CLOUD_URL)."));
    } finally {
      stop();
    }
  } catch (err) {
    sink.emit(errorBox(err instanceof Error ? err.message : String(err), "Try /agent list."));
  }
}

async function handlePromptLine(sink: LineSink, text: string, refs: string[]): Promise<void> {
  if (refs.length === 0) {
    const stop = sink.spin("asking opencode …");
    try {
      const reply = await chatLocal(text);
      if (!reply.trim() || /^(answer|reply)$/i.test(reply.trim())) {
        throw new Error("[cli] opencode cloud returned an empty reply (shape mismatch).");
      }
      sink.emit(header("opencode — reply"));
      sink.emit(box([statusLine("ok", "reply"), separator(76), ...reply.split("\n").slice(0, 30)]));
    } catch (err) {
      sink.emit(errorBox(err instanceof Error ? err.message : String(err), "Вставь ключ через /connect в TUI (см. apps/cli/.env.example, OPENCODE_CLOUD_URL)."));
    } finally {
      stop();
    }
    return;
  }
  let root: string;
  try {
    root = getReposRoot();
  } catch (err) {
    sink.emit(errorBox(err instanceof Error ? err.message : String(err), "Set REPOS_ROOT in your .env (see .env.example)."));
    return;
  }
  const previews: string[] = [];
  for (const ref of refs) {
    try {
      const resolved = await resolveRef(ref, root);
      sink.emit(header(`@ref ${resolved.rel}`));
      sink.emit(box([resolved.isDir ? "(directory)" : `(file) ${resolved.rel}`, separator(76), ...resolved.preview.split("\n").slice(0, 20)]));
      previews.push(`@${resolved.rel}\n${resolved.preview}`);
    } catch (err) {
      sink.emit(errorBox(err instanceof Error ? err.message : String(err), "Refs stay inside REPOS_ROOT; \"..\" is denied."));
    }
  }
  const enriched = previews.length > 0 ? `${text}\n\n${previews.join("\n\n")}` : text;
  const stop = sink.spin("asking opencode …");
  try {
    const reply = await chatLocal(enriched);
    if (!reply.trim() || /^(answer|reply)$/i.test(reply.trim())) {
      throw new Error("[cli] opencode cloud returned an empty reply (shape mismatch).");
    }
    sink.emit(header("opencode — reply"));
    sink.emit(box([statusLine("ok", "reply"), separator(76), ...reply.split("\n").slice(0, 30)]));
  } catch (err) {
    sink.emit(errorBox(err instanceof Error ? err.message : String(err), "Вставь ключ через /connect в TUI (см. apps/cli/.env.example, OPENCODE_CLOUD_URL)."));
  } finally {
    stop();
  }
}

/** Shared line dispatch for both REPL frontends. Returns true on /exit. */
async function dispatchLine(sink: LineSink, raw: string): Promise<boolean> {
  let parsed;
  try {
    parsed = parseLine(raw);
  } catch (err) {
    sink.emit(errorBox(err instanceof Error ? err.message : String(err), "Try /help."));
    return false;
  }
  switch (parsed.kind) {
    case "empty":
      return false;
    case "help":
      sink.emit(header("DEVBOX CLI — help"));
      sink.emit(box(helpText().split("\n")));
      return false;
    case "exit":
      sink.emit(okBox(["bye ✓"]));
      return true;
    case "agent-list":
      await cmdAgentList(sink);
      return false;
    case "agent-run":
      await cmdAgentRun(sink, parsed.agent, parsed.prompt, parsed.apply);
      return false;
    case "prompt":
      await handlePromptLine(sink, parsed.text, parsed.refs);
      return false;
  }
}

function startReadlineRepl(): void {
  // Clear first (TTY only — caller gates on isTTY; never --help/CI paths),
  // then greeting + history on top, prompt stays the last line.
  // Fail-fast REPOS_ROOT/serve errors surface after clear in ✗-boxes.
  clearScreen((s) => void process.stdout.write(s));
  out(greeting(VERSION));
  out(box(startupHintLines()));
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT_LABEL });
  rl.prompt();
  rl.on("line", (raw: string) => {
    void (async () => {
      const shouldExit = await dispatchLine(stdoutSink, raw);
      if (shouldExit) {
        rl.close();
        return;
      }
      // Re-render prompt last so input stays bottom after every reply.
      rl.prompt();
    })();
  });
  rl.on("close", () => {
    out(statusLine("ok", "session closed"));
    process.exit(0);
  });
}

async function startTuiReplCli(): Promise<void> {
  await startTuiRepl({
    greeting: greeting(VERSION),
    hints: box(startupHintLines()),
    clear: clearScreen,
    onLine: async (line: string, session: TuiSession) => ({ exit: await dispatchLine(tuiSink(session), line) }),
  });
  out(statusLine("ok", "session closed"));
  process.exit(0);
}

function startRepl(): void {
  // Transparent OpenTUI layer on TTY; stdout fallback when the native
  // bindings fail to load (CI-safe: the REPL still works line by line).
  if (shouldUseTui(process.argv.slice(2), process.stdin.isTTY ?? false)) {
    void (async () => {
      try {
        await startTuiReplCli();
      } catch {
        startReadlineRepl();
      }
    })();
    return;
  }
  startReadlineRepl();
}

// Note: non-REPL routes (help/version/agent/resolve/unknown) and the
// !isTTY fallback never clear — showHelp() writes directly, no clear.

async function main(): Promise<void> {
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
      out(errorBox("[cli] agent run needs a prompt — usage: cli agent run <name> <prompt> [--apply].", "Try /agent list."));
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
    out(errorBox(`[cli] unknown args ${JSON.stringify(args.join(" "))} — try cli --help.`, "cli agent list | cli resolve @path | cli repl"));
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    showHelp();
    return;
  }
  startRepl();
}

await main();
