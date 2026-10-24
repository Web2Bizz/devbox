// commands/runners — OpenTUI runners (lazy dynamic import, TTY REPL only).
// The React tree (../ui/screens/index.js) plus the renderer/react bindings load through
// dynamic import(), so --help / non-TTY / CI paths never touch the native
// bindings or the reconciler.
import { AGENT_FG, USER_FG, resolveTerminalWidth } from "../ui/shared/chat.js";
import { TUI_HISTORY_CAP, TUI_TARGET_FPS, type TuiLineResult, type TuiSession } from "./session.js";
import { TUI_INPUT_MAX_LENGTH, normalizePastedText } from "../core/utils/paste.js";
import type { ReactElement } from "react";
import type { createRoot } from "@opentui/react";
import { createLineStore, type LineStore } from "../ui/shared/store.js";
import type { HomeOptionIndex } from "../ui/screens/home/index.js";

type TuiHostMount<T> = (
  react: typeof import("react"),
  app: typeof import("../ui/screens/index.js"),
  finish: (value: T) => void,
) => ReactElement;

/**
 * OpenTUI host: lazy dynamic imports (so --help / non-TTY / CI never touch
 * the native bindings or the reconciler), renderer bootstrap, one-shot
 * mount, best-effort teardown. `finish` resolves once (first call wins).
 */
async function withTuiHost<T>(mount: TuiHostMount<T>): Promise<T> {
  const [{ createCliRenderer }, react, reactOpentui, app] = await Promise.all([
    import("@opentui/core"),
    import("react"),
    import("@opentui/react"),
    import("../ui/screens/index.js"),
  ]);
  const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: TUI_TARGET_FPS });
  try {
    return await new Promise<T>((resolve) => {
      let done = false;
      const root: ReturnType<typeof createRoot> = reactOpentui.createRoot(renderer);
      const finish = (value: T): void => {
        if (done) return;
        done = true;
        try {
          root.unmount();
        } catch {
          // Best-effort teardown.
        }
        renderer.destroy();
        resolve(value);
      };
      root.render(mount(react, app, finish));
    });
  } finally {
    try {
      await renderer.closed;
    } catch {
      // Teardown is best-effort.
    }
  }
}

export async function startTuiRepl(options: {
  greeting: string;
  clear: (write: (chunk: string) => void) => void;
  onLine: (line: string, session: TuiSession) => Promise<TuiLineResult>;
}): Promise<void> {
  const [{ createCliRenderer }, react, reactOpentui, app] = await Promise.all([
    import("@opentui/core"),
    import("react"),
    import("@opentui/react"),
    import("../ui/screens/index.js"),
  ]);
  options.clear((s) => void process.stdout.write(s));
  const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: TUI_TARGET_FPS });
  const store: LineStore = createLineStore(TUI_HISTORY_CAP);
  // Single greeting frame on top, before the first paint.
  store.push(options.greeting);
  // Live width: renderer dims first, then the React tree reports resizes;
  // session.width() reads the live ref below.
  const widthRef = { current: resolveTerminalWidth(renderer, 80) };
  const onWidth = (width: number): void => {
    if (Number.isFinite(width) && width > 0) widthRef.current = Math.floor(width);
  };
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session: TuiSession = {
    print: (text: string, opts?: { fg?: string }) => {
      // Full-width plain lines: width 100% + fg only, never a backdrop.
      store.push(text, opts?.fg ? { fg: opts.fg, kind: "plain" } : { kind: "plain" });
    },
    printUser: (text: string) => {
      store.push(text, { fg: USER_FG, kind: "user" });
    },
    printAgent: (text: string) => {
      store.push(text, { fg: AGENT_FG, kind: "agent" });
    },
    printTitle: (text: string) => {
      // Verbatim: no word-split/trim — double spaces kept 1-в-1;
      // wrapMode none + truncate false → left-align, right-clip, no mid wrap.
      store.push(text, { title: true, kind: "title" });
    },
    header: (title: string) => {
      store.push(title, { kind: "header", fg: "yellow" });
    },
    box: (lines: string[]) => {
      store.push(lines.join("\n"), { kind: "box" });
    },
    error: (message: string, hint?: string) => {
      store.push(hint ? `${message}\n${hint}` : message, { kind: "error", fg: "red" });
    },
    table: (headers: string[], rows: string[][]) => {
      store.push(JSON.stringify({ headers, rows }), { kind: "table" });
    },
    spin: (label: string) => {
      const id = store.pushOwned(label, { kind: "spinner" });
      return () => {
        store.remove(id);
      };
    },
    width: () => widthRef.current,
  };
  // Declarative tree: <ReplApp/> owns history + the prompt input; ENTER
  // arrives through the input onSubmit prop and is normalized here.
  const onSubmitLine = (raw: string): void => {
    const line = normalizePastedText(raw);
    void (async () => {
      try {
        const result = await options.onLine(line, session);
        if (result.exit) finish();
      } catch {
        // Declarative focus (focused prop) survives errors; nothing to redo.
      }
    })();
  };
  const root = reactOpentui.createRoot(renderer);
  root.render(react.createElement(app.ReplApp, { store, maxLength: TUI_INPUT_MAX_LENGTH, onSubmitLine, onWidth }));
  await finished;
  try {
    root.unmount();
  } catch {
    // Teardown is best-effort.
  }
  renderer.destroy();
  try {
    await renderer.closed;
  } catch {
    // Teardown is best-effort.
  }
}

/**
 * OpenTUI home menu (Главная): the block-art title renders once as static
 * <text> rows (title path — verbatim, no wrap/trim, right-clip when narrow;
 * logo gradient via per-chunk hex fg, no ANSI in content), then the
 * signature on the same left edge, then the 3 options as separate <text>
 * nodes in the same left-aligned block whose content React repaints from
 * `selected` state.
 * Arrows ↑↓ only move that state (marker `›` follows) — no clear, no
 * art/signature reprint, no flicker. Transparency: fg-only, never backdrop.
 * Digits 1-3 select immediately, Enter confirms, Ctrl+C / q / Esc → exit.
 */
export async function startTuiHome(options?: { initialSelected?: HomeOptionIndex }): Promise<HomeOptionIndex> {
  return withTuiHost<HomeOptionIndex>((react, app, finish) =>
    react.createElement(app.HomeApp, {
      initialSelected: options?.initialSelected ?? 0,
      onSelect: (index: HomeOptionIndex) => finish(index),
    }),
  );
}

/**
 * OpenTUI project picker: <ProjectsScreen/> lists `projects` (`1. name`
 * rows, `›` follows `selected`). Enter/digits confirm, Esc/q cancels.
 * Resolves { index, name } on select, null on cancel/unmount.
 */
export async function startTuiProjects(projects: string[]): Promise<{ index: number; name: string } | null> {
  return withTuiHost<{ index: number; name: string } | null>((react, app, finish) =>
    react.createElement(app.ProjectsScreen, {
      projects,
      onSelect: (index: number | null, name: string | null) =>
        finish(index === null || name === null ? null : { index, name }),
      onCancel: () => finish(null),
    }),
  );
}

/**
 * OpenTUI error frame: <ErrorScreen/> shows message + hint, resolves on
 * Enter/Esc/q. Chat/open flows only — no stdio.
 */
export async function startTuiError(message: string, hint?: string): Promise<void> {
  return withTuiHost<void>((react, app, finish) =>
    react.createElement(app.ErrorScreen, { message, hint, onClose: () => finish(undefined) }),
  );
}

/**
 * OpenTUI custom directory input: <DirInputScreen/> with a single focused
 * <input> (paste-safe maxLength). Resolves the raw value on Enter,
 * null on Esc.
 */
export async function startTuiDirInput(initialValue?: string): Promise<string | null> {
  return withTuiHost<string | null>((react, app, finish) =>
    react.createElement(app.DirInputScreen, {
      initialValue,
      onSubmit: (value: string) => finish(value),
      onCancel: () => finish(null),
    }),
  );
}
