// commands/interactive — TUI-only interactive flows (chat).
// One-shot commands (agent list/run, --help/--version) stay on
// stdout in ./commands.js + cli.ts — this module never uses stdio for
// interaction. The only stdout writes here are the final exit statusLines
// after the renderer is destroyed (not interaction, must stay).
import { greetingLines, statusLine } from "../ui/shared/plain.js";
import {
  startTuiError,
  startTuiHome,
  startTuiRepl,
} from "./runners.js";
import type { TuiSession } from "./session.js";
import { clearScreen } from "../prompt/repl.js";
import { dispatchLine } from "./commands.js";
import { out, tuiSink } from "./sinks.js";

export function sessionLabelFor(): string {
  return "RUSH CODE — Сессия";
}

export async function startTuiReplCli(sessionLabel?: string, version = ""): Promise<void> {
  const greetingFrame = sessionLabel ? `${greetingLines(version).join("\n")}\n${sessionLabel}` : greetingLines(version).join("\n");
  await startTuiRepl({
    greeting: greetingFrame,
    clear: clearScreen,
    onLine: async (line: string, session: TuiSession) => ({ exit: await dispatchLine(tuiSink(session), line) }),
  });
  out(statusLine("ok", "session closed"));
  process.exit(0);
}

/** RUSH CODE home first (Главная), then Сессия (chat). */
export function startRepl(version = ""): void {
  // Always TUI: home → chat. Non-TTY never reaches
  // here (cli.ts main gates on stdin.isTTY). Renderer failures are fatal
  // (stderr + exitCode 1) — no stdio fallback inside interactive flows.
  void (async () => {
    try {
      const homeIndex = await startTuiHome();
      if (homeIndex === 1) {
        out(statusLine("ok", "bye ✓"));
        process.exit(0);
        return;
      }
      const label = sessionLabelFor();
      await startTuiReplCli(label, version);
    } catch (err) {
      process.stderr.write(`[cli] TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  })();
}
