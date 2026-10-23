// ui/tui — OpenTUI transparent renderer (TTY REPL only, lazy-loaded).
// Transparency contract: the root never paints its own color — the terminal
// shows through. No backdrop props are passed to any renderable, so the
// ascii boxes from box.ts (width 80) stay the visible content. The module is
// imported dynamically, so --help / non-TTY / CI paths never touch the
// native bindings. Secrets are never logged here; chat scrub rules live in
// agents/opencode.ts and are untouched by this layer.
import { shouldClearScreen, shouldStartRepl } from "../prompt/repl.js";
import { SPINNER_FRAMES, spinnerLine } from "./spinner.js";
/** How many history lines the TUI keeps before trimming the oldest. */
export const TUI_HISTORY_CAP = 400;
/** Max input length (paste-safe). Upstream InputRenderable defaults to 1000. */
export const TUI_INPUT_MAX_LENGTH = 10000;
const BRACKETED_START = String.fromCharCode(27) + "[200~";
const BRACKETED_END = String.fromCharCode(27) + "[201~";
export function normalizePastedText(raw: string): string {
  const deBracketed = raw.split(BRACKETED_START).join("").split(BRACKETED_END).join("");
  const lf = deBracketed.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const C0 = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", "g");
  const singleLine = lf.split("\n").map((line) => line.replace(C0, "").replace(/\t/g, " ")).join(" ");
  const collapsed = singleLine.replace(/ {2,}/g, " ").trim();
  return [...collapsed].slice(0, TUI_INPUT_MAX_LENGTH).join("");
}
/** Frame budget for the REPL renderer (demand-driven; frames on mutation). */
export const TUI_TARGET_FPS = 30;
/** Startup order mirror: reset first, greeting + hints on top, input last. */
export function tuiStartupOrder(): Array<"clear" | "greeting" | "history" | "prompt"> {
  return ["clear", "greeting", "history", "prompt"];
}
/** True only for the interactive TTY REPL route (never --help/CI). */
export function shouldUseTui(args: string[], isTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.DEVBOX_NO_TUI ?? "").trim() === "1") return false;
  return shouldStartRepl(args, isTTY) && shouldClearScreen(isTTY);
}
type TuiOptions = { [option: string]: string | number | boolean | undefined };
type TuiRenderable = {
  add: (child: TuiRenderable, index?: number) => number;
  remove: (child: TuiRenderable) => void;
  destroyRecursively: () => void;
};
type TuiTextNode = TuiRenderable & { content: string };
type TuiInputNode = TuiRenderable & {
  focus: () => void;
  blur?: () => void;
  on: (event: string, listener: (value: string) => void) => void;
  value: string;
  maxLength?: number;
};
type TuiRenderer = {
  root: TuiRenderable;
  destroy: () => void;
  closed: Promise<unknown>;
};
type TuiCore = {
  createCliRenderer: (options?: { exitOnCtrlC?: boolean; targetFps?: number }) => Promise<TuiRenderer>;
  BoxRenderable: new (renderer: TuiRenderer, options?: TuiOptions) => TuiRenderable;
  ScrollBoxRenderable: new (renderer: TuiRenderer, options?: TuiOptions) => TuiRenderable;
  TextRenderable: new (renderer: TuiRenderer, options?: TuiOptions & { content?: string }) => TuiTextNode;
  InputRenderable: new (renderer: TuiRenderer, options?: TuiOptions & { placeholder?: string }) => TuiInputNode;
  InputRenderableEvents: { ENTER: string; INPUT?: string; CHANGE?: string };
};
export type TuiSession = {
  print: (text: string) => void;
  spin: (label: string) => () => void;
};
export type TuiLineResult = { exit: boolean };
async function loadTuiCore(): Promise<TuiCore> {
  const mod = (await import("@opentui/core")) as unknown as TuiCore;
  return mod;
}
export async function startTuiRepl(options: {
  greeting: string;
  hints: string;
  clear: (write: (chunk: string) => void) => void;
  onLine: (line: string, session: TuiSession) => Promise<TuiLineResult>;
}): Promise<void> {
  const core = await loadTuiCore();
  options.clear((s) => void process.stdout.write(s));
  const renderer = await core.createCliRenderer({ exitOnCtrlC: true, targetFps: TUI_TARGET_FPS });
  const root = new core.BoxRenderable(renderer, {
    flexDirection: "column",
    justifyContent: "space-between",
    alignItems: "stretch",
    width: "100%",
    height: "100%",
  });
  const history = new core.ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
  });
  const input = new core.InputRenderable(renderer, {
    placeholder: "prompt > ",
    width: "100%",
    maxLength: TUI_INPUT_MAX_LENGTH,
  });
  root.add(history);
  root.add(input);
  renderer.root.add(root);
  const nodes: TuiTextNode[] = [];
  const dropOldest = (): void => {
    const oldest = nodes.shift();
    if (oldest) {
      history.remove(oldest);
      oldest.destroyRecursively();
    }
  };
  const refocus = (): void => {
    try {
      input.focus();
    } catch {
      // Best-effort; readline fallback (DEVBOX_NO_TUI=1) never needs this.
    }
  };
  const session: TuiSession = {
    print: (text: string) => {
      for (const raw of text.split("\n")) {
        const line = new core.TextRenderable(renderer, { content: raw === "" ? " " : raw });
        nodes.push(line);
        history.add(line);
      }
      while (nodes.length > TUI_HISTORY_CAP) dropOldest();
      refocus();
    },
    spin: (label: string) => {
      const node = new core.TextRenderable(renderer, { content: spinnerLine(0, label) });
      history.add(node);
      let frame = 0;
      const timer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        node.content = spinnerLine(frame, label);
      }, 80);
      return () => {
        clearInterval(timer);
        history.remove(node);
        node.destroyRecursively();
        refocus();
      };
    },
  };
  session.print(options.greeting);
  session.print(options.hints);
  await new Promise<void>((resolve) => {
    input.on(core.InputRenderableEvents.ENTER, (value: string) => {
      const line = normalizePastedText(value);
      input.value = "";
      refocus();
      void (async () => {
        try {
          const result = await options.onLine(line, session);
          if (result.exit) resolve();
          else refocus();
        } catch {
          refocus();
        }
      })();
    });
    input.focus();
  });
  renderer.destroy();
  try {
    await renderer.closed;
  } catch {
    // Teardown is best-effort.
  }
}
