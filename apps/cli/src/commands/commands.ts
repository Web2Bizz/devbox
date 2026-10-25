// commands/commands — /agent, resolve, prompt dispatch (pure dispatch, no readline).
import { helpText, parseLine } from "../prompt/repl.js";
import { listAgents } from "../agents/allowlist.js";
import { runAgent } from "../agents/runner.js";
import { chatLocal } from "../agents/opencode/index.js";
import { emitBox, emitError, emitHeader, emitTable, type LineSink } from "./sinks.js";

export async function cmdAgentList(sink: LineSink): Promise<void> {
  const agents = listAgents();
  emitHeader(sink, "agents — allowlist (dry-run by default)");
  emitTable(sink, ["agent", "description"], agents.map((a) => [a.name, a.description]));
}

export async function cmdAgentRun(sink: LineSink, name: string, prompt: string, apply: boolean): Promise<void> {
  try {
    const run = runAgent(name, prompt, apply);
    if (run.dryRun) {
      // Chat echo: user prompt cyan + dry-run notice green, plain full-width.
      sink.user(run.prompt);
      sink.agent(`dry-run @${run.agent}: ${run.message} — re-run with --apply (cloud: нужен ключ в auth.json).`);
      return;
    }
    sink.user(run.prompt);
    const stop = sink.spin(`asking opencode @${run.agent} …`);
    try {
      const reply = await chatLocal(run.prompt);
      if (!reply.trim() || /^(answer|reply)$/i.test(reply.trim())) {
        throw new Error("[cli] opencode cloud returned an empty reply (shape mismatch).");
      }
      sink.agent(reply.split("\n").slice(0, 30).join("\n"));
    } catch (err) {
      emitError(sink, err instanceof Error ? err.message : String(err), "Вставь ключ через /connect в TUI (см. apps/cli/.env.example, OPENCODE_CLOUD_URL).");
    } finally {
      stop();
    }
  } catch (err) {
    emitError(sink, err instanceof Error ? err.message : String(err), "Try /agent list.");
  }
}

export async function handlePromptLine(sink: LineSink, text: string, refs: string[]): Promise<void> {
  sink.user(text);
  const stop = sink.spin("asking opencode …");
  try {
    const reply = await chatLocal(text);
    if (!reply.trim() || /^(answer|reply)$/i.test(reply.trim())) {
      throw new Error("[cli] opencode cloud returned an empty reply (shape mismatch).");
    }
    sink.agent(reply.split("\n").slice(0, 30).join("\n"));
  } catch (err) {
    emitError(sink, err instanceof Error ? err.message : String(err), "Вставь ключ через /connect в TUI (см. apps/cli/.env.example, OPENCODE_CLOUD_URL).");
  } finally {
    stop();
  }
}

/** Shared line dispatch for both REPL frontends. Returns true on /exit. */
export async function dispatchLine(sink: LineSink, raw: string): Promise<boolean> {
  let parsed;
  try {
    parsed = parseLine(raw);
  } catch (err) {
    emitError(sink, err instanceof Error ? err.message : String(err), "Try /help.");
    return false;
  }
  switch (parsed.kind) {
    case "empty":
      return false;
    case "help":
      emitHeader(sink, "RUSH CODE CLI — help");
      emitBox(sink, helpText().split("\n"));
      return false;
    case "exit":
      emitBox(sink, ["✓ bye ✓"]);
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
