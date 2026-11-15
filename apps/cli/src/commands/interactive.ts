// commands/interactive — TUI-only interactive flows (chat).
// One-shot commands (agent list/run, --help/--version) stay on
// stdout in ./commands.js + cli.ts — this module never uses stdio for
// interaction. The only stdout writes here are the final exit statusLines
// after the renderer is destroyed (not interaction, must stay).
import { greetingLines, statusLine } from "../ui/shared/plain.js";
import {
  getSessionsClient,
  startTuiChat,
  startTuiError,
  startTuiHome,
  startTuiLogin,
  startTuiRepl,
  startTuiSessions,
  startTuiSessionsGrid,
} from "./runners.js";
import { closeSession } from "../core/queries/sessions/index.js";
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

/** Login route: login hint screen, then back. TUI-only, final statusLine via out(). */
export async function startLoginFlow(loginUrl?: string): Promise<boolean> {
  const done = await startTuiLogin(loginUrl);
  out(statusLine(done ? "ok" : "warn", done ? "login done" : "login cancelled"));
  return done;
}

/** Sessions route: picker → chat. sessions→chat via startTuiChat. */
export async function startSessionsFlow(version = ""): Promise<void> {
  const client = getSessionsClient();
  const snap = await client.refresh();
  if (snap.status === "error") {
    await startTuiError(snap.error ?? "sessions unavailable", "проверь RUSH_CODE_BACKEND_URL");
    return;
  }
  const picked = await startTuiSessions(snap.sessions);
  if (!picked) {
    out(statusLine("warn", "sessions cancelled"));
    return;
  }
  await startTuiChat({
    sessionId: picked.id,
    origin: picked.origin,
    greeting: greetingLines(version).join("\n"),
  });
  out(statusLine("ok", "session closed"));
}

/** Sessions-grid route: 2D grid, Enter opens chat, x/d closes + invalidates. */
export async function startSessionsGridFlow(version = ""): Promise<void> {
  const client = getSessionsClient();
  for (;;) {
    const snap = await client.refresh();
    if (snap.status === "error") {
      await startTuiError(snap.error ?? "sessions unavailable", "проверь RUSH_CODE_BACKEND_URL");
      return;
    }
    const result = await startTuiSessionsGrid(snap.sessions, 2);
    if (result.action === "back") {
      out(statusLine("warn", "grid closed"));
      return;
    }
    if (result.action === "close") {
      try {
        await closeSession(result.session.id);
      } catch {
        // Close is best-effort; invalidate below still refreshes the view.
      }
      await client.invalidate();
      continue;
    }
    await startTuiChat({
      sessionId: result.session.id,
      origin: result.session.origin,
      greeting: greetingLines(version).join("\n"),
    });
    out(statusLine("ok", "session closed"));
    return;
  }
}
