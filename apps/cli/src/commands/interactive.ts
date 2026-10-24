// commands/interactive — TUI-only interactive flows (chat + project open).
// One-shot commands (agent list/run, resolve, --help/--version) stay on
// stdout in ./commands.js + cli.ts — this module never uses stdio for
// interaction. The only stdout writes here are the final exit statusLines
// after the renderer is destroyed (not interaction, must stay).
import { greetingLines, statusLine } from "../ui/shared/plain.js";
import {
  startTuiDirInput,
  startTuiError,
  startTuiHome,
  startTuiProjects,
  startTuiRepl,
} from "./runners.js";
import type { TuiSession } from "./session.js";
import { clearScreen } from "../prompt/repl.js";
import { listProjects, resolveCustomDir, resolveProjectDir } from "../core/queries/refs/projects.js";
import { dispatchLine } from "./commands.js";
import { out, tuiSink } from "./sinks.js";

/** TUI project picker: same data (listProjects/resolveProjectDir), React UI. */
export async function chooseProjectDir(): Promise<string | null> {
  let projects: string[];
  try {
    projects = await listProjects();
  } catch (err) {
    await startTuiError(
      err instanceof Error ? err.message : String(err),
      "Положи каталог проекта внутрь REPOS_ROOT или проверь путь в .env.",
    );
    return null;
  }
  let picked: { index: number; name: string } | null;
  try {
    picked = await startTuiProjects(projects);
  } catch {
    // Native bindings failed: back home, no stdio noise.
    return null;
  }
  if (!picked) return null;
  const name = picked.name.trim();
  if (!name) return null;
  try {
    return await resolveProjectDir(name);
  } catch (err) {
    await startTuiError(err instanceof Error ? err.message : String(err), "Выбери имя из списка выше.");
    return null;
  }
}

/** TUI custom directory input: same data (resolveCustomDir), React UI. */
export async function chooseCustomDir(): Promise<string | null> {
  let answer: string | null;
  try {
    answer = await startTuiDirInput();
  } catch {
    // Native bindings failed: back home, no stdio noise.
    return null;
  }
  if (answer === null) return null;
  if (!answer.trim()) return null;
  try {
    return await resolveCustomDir(answer.trim());
  } catch (err) {
    await startTuiError(err instanceof Error ? err.message : String(err), 'Путь остаётся внутри REPOS_ROOT; ".." запрещён.');
    return null;
  }
}

export function sessionLabelFor(dir: string): string {
  const short = dir.split("/").filter(Boolean).pop() ?? dir;
  return `RUSH CODE — Сессия: ${short} (${dir})`;
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

/** RUSH CODE home first (Главная), then Сессия (chat) for the chosen dir. */
export function startRepl(version = ""): void {
  // Always TUI: home → project/dir picker → chat. Non-TTY never reaches
  // here (cli.ts main gates on stdin.isTTY). Renderer failures are fatal
  // (stderr + exitCode 1) — no stdio fallback inside interactive flows.
  void (async () => {
    try {
      const homeIndex = await startTuiHome();
      if (homeIndex === 2) {
        out(statusLine("ok", "bye ✓"));
        process.exit(0);
        return;
      }
      const dir = homeIndex === 0 ? await chooseProjectDir() : await chooseCustomDir();
      if (!dir) {
        // Cancelled (Esc) or TUI error already shown; back to home.
        startRepl(version);
        return;
      }
      const label = sessionLabelFor(dir);
      await startTuiReplCli(label, version);
    } catch (err) {
      process.stderr.write(`[cli] TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  })();
}
