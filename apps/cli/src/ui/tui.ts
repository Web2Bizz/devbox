// ui/tui — OpenTUI transparent renderer (TTY REPL only, lazy-loaded).
// Transparency contract: the root never paints its own color — the terminal
// shows through. No backdrop/bg props are passed to any renderable (fg-only:
// user cyan, agent green per ui/chat.ts). History + all message lines are
// width 100% (full terminal; renderer → stdout.columns → 80), never fixed 80.
// Greeting + errorBox boxes stay as-is; chat messages are plain wrapped text.
// The module is imported dynamically, so --help / non-TTY / CI paths never
// touch the native bindings. Secrets are never logged here; chat scrub rules
// live in agents/opencode.ts and are untouched by this layer.
import { shouldClearScreen, shouldStartRepl } from "../prompt/repl.js";
import { SPINNER_FRAMES, spinnerLine } from "./spinner.js";
import { AGENT_FG, USER_FG, resolveTerminalWidth } from "./chat.js";
import {
  HOME_OPTIONS,
  HOME_SIGNATURE,
  HOME_TITLE_ART,
  centerLines,
  moveHomeSelection,
  titleTextOptions,
  type HomeOptionIndex,
} from "./home.js";
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
/** Startup order mirror: reset first, single greeting frame on top, input last. */
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
type TuiKey = { name: string; ctrl?: boolean; sequence?: string };
type TuiRenderer = {
  root: TuiRenderable;
  keyInput: {
    on: (event: string, listener: (key: TuiKey) => void) => void;
    off: (event: string, listener: (key: TuiKey) => void) => void;
  };
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
  print: (text: string, opts?: { fg?: string }) => void;
  printUser: (text: string) => void;
  printAgent: (text: string) => void;
  /** Verbatim block-art title: no wrap/trim, left-align + right-clip when narrow. */
  printTitle: (text: string) => void;
  spin: (label: string) => () => void;
  /** Full terminal width (renderer → stdout.columns → 80). */
  width: () => number;
};
export type TuiLineResult = { exit: boolean };
async function loadTuiCore(): Promise<TuiCore> {
  const mod = (await import("@opentui/core")) as unknown as TuiCore;
  return mod;
}
export async function startTuiRepl(options: {
  greeting: string;
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
  const getWidth = (): number => resolveTerminalWidth(renderer, 80);
  const session: TuiSession = {
    print: (text: string, opts?: { fg?: string }) => {
      for (const raw of text.split("\n")) {
        // Full-width plain lines: width 100% + fg only, never bg/backdrop.
        const line = new core.TextRenderable(renderer, {
          content: raw === "" ? " " : raw,
          width: "100%",
          ...(opts?.fg ? { fg: opts.fg } : {}),
        });
        nodes.push(line);
        history.add(line);
      }
      while (nodes.length > TUI_HISTORY_CAP) dropOldest();
      refocus();
    },
    printUser: (text: string) => {
      for (const raw of text.split("\n")) {
        const line = new core.TextRenderable(renderer, {
          content: raw === "" ? " " : raw,
          width: "100%",
          fg: USER_FG,
        });
        nodes.push(line);
        history.add(line);
      }
      while (nodes.length > TUI_HISTORY_CAP) dropOldest();
      refocus();
    },
    printAgent: (text: string) => {
      for (const raw of text.split("\n")) {
        const line = new core.TextRenderable(renderer, {
          content: raw === "" ? " " : raw,
          width: "100%",
          fg: AGENT_FG,
        });
        nodes.push(line);
        history.add(line);
      }
      while (nodes.length > TUI_HISTORY_CAP) dropOldest();
      refocus();
    },
    printTitle: (text: string) => {
      const verbatim = titleTextOptions();
      for (const raw of text.split("\n")) {
        // Verbatim: no word-split/trim — double spaces kept 1-в-1;
        // wrapMode none + truncate false → left-align, right-clip, no mid wrap.
        const line = new core.TextRenderable(renderer, {
          content: raw === "" ? " " : raw,
          width: verbatim.width,
          wrapMode: verbatim.wrapMode,
          truncate: verbatim.truncate,
        });
        nodes.push(line);
        history.add(line);
      }
      while (nodes.length > TUI_HISTORY_CAP) dropOldest();
      refocus();
    },
    spin: (label: string) => {
      const node = new core.TextRenderable(renderer, { content: spinnerLine(0, label), width: "100%" });
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
    width: getWidth,
  };
  session.print(options.greeting);
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

/**
 * Left-aligned home option line on the art left edge (artLeft, same block
 * as art + signature). Only the `›` marker differs between rows — the art
 * block is never part of this string. Narrow terminal (artLeft=0) → col 0.
 * Pure helper for the TUI selector (and its tests).
 */
export function homeOptionLine(index: number, selected: number, width = 80): string {
  const marker = index === selected ? "› " : "  ";
  const raw = `${marker}${index + 1}. ${HOME_OPTIONS[index] ?? ""}`;
  const safe = Math.max(20, Math.floor(width) || 80);
  const artWidth = Math.max(...[...HOME_TITLE_ART].map((line) => [...line].length));
  const artLeft = artWidth >= safe ? 0 : Math.floor((safe - artWidth) / 2);
  return " ".repeat(artLeft) + raw;
}

/**
 * Left-aligned home signature line on the same art left edge (artLeft).
 * Drawn once right below the art, never carries the `›` marker.
 */
export function homeSignatureLine(width = 80): string {
  const safe = Math.max(20, Math.floor(width) || 80);
  const artWidth = Math.max(...[...HOME_TITLE_ART].map((line) => [...line].length));
  const artLeft = artWidth >= safe ? 0 : Math.floor((safe - artWidth) / 2);
  return " ".repeat(artLeft) + HOME_SIGNATURE;
}

/**
 * Centered block-art title as a unit (single left offset, verbatim
 * double spaces 1-в-1; narrow → left-aligned, right-clip only).
 * Mirrors renderHomeScreen artBlock so the TUI matches the stdout home.
 */
export function homeArtLines(width = 80): string[] {
  const safe = Math.max(20, Math.floor(width) || 80);
  const artWidth = Math.max(...[...HOME_TITLE_ART].map((line) => [...line].length));
  const artLeft = artWidth >= safe ? 0 : Math.floor((safe - artWidth) / 2);
  return [...HOME_TITLE_ART].map((line) => " ".repeat(artLeft) + line);
}

/**
 * OpenTUI home menu (Главная): block-art title is drawn once as static
 * nodes (title path — verbatim, no wrap/trim, right-clip when narrow),
 * then the signature on the same left edge, then the 3 options as
 * separate nodes in the same left-aligned block whose `content` is
 * updated in place.
 * Arrows ↑↓ only repaint the option rows (marker `›` moves) — no clear,
 * no art/signature reprint, no flicker. Transparency: fg-only, never bg/backdrop.
 * Digits 1-3 select immediately, Enter confirms, Ctrl+C / q / Esc → exit.
 */
export async function startTuiHome(options?: { initialSelected?: HomeOptionIndex }): Promise<HomeOptionIndex> {
  const core = await loadTuiCore();
  const renderer = await core.createCliRenderer({ exitOnCtrlC: true, targetFps: TUI_TARGET_FPS });
  const width = resolveTerminalWidth(renderer, 80);
  const root = new core.BoxRenderable(renderer, {
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    width: "100%",
    height: "100%",
  });
  renderer.root.add(root);
  // Static art: drawn once, never mutated afterwards (no flicker).
  const verbatim = titleTextOptions();
  const artNodes: TuiTextNode[] = homeArtLines(width).map(
    (line) =>
      new core.TextRenderable(renderer, {
        content: line === "" ? " " : line,
        width: verbatim.width,
        wrapMode: verbatim.wrapMode,
        truncate: verbatim.truncate,
      }),
  );
  for (const node of artNodes) root.add(node);
  const signatureNode = new core.TextRenderable(renderer, {
    content: homeSignatureLine(width),
    width: "100%",
  });
  root.add(signatureNode);
  const gap = new core.TextRenderable(renderer, { content: " ", width: "100%" });
  root.add(gap);
  // Selector: separate nodes, incremental marker update only.
  let selected: HomeOptionIndex = options?.initialSelected ?? 0;
  const optionNodes: TuiTextNode[] = HOME_OPTIONS.map(
    (_, i) =>
      new core.TextRenderable(renderer, {
        content: homeOptionLine(i, selected, width),
        width: "100%",
      }),
  );
  for (const node of optionNodes) root.add(node);
  const hintGap = new core.TextRenderable(renderer, { content: " ", width: "100%" });
  root.add(hintGap);
  const hintLines = centerLines(["↑↓ + Enter · или 1-3"], width);
  const hintNode = new core.TextRenderable(renderer, {
    content: hintLines[0] ?? "↑↓ + Enter · или 1-3",
    width: "100%",
  });
  root.add(hintNode);
  const paintOptions = (): void => {
    for (let i = 0; i < optionNodes.length; i += 1) {
      const node = optionNodes[i];
      if (node) node.content = homeOptionLine(i, selected, width);
    }
  };
  try {
    return await new Promise<HomeOptionIndex>((resolve) => {
      let done = false;
      const finish = (index: HomeOptionIndex): void => {
        if (done) return;
        done = true;
        try {
          renderer.keyInput.off("keypress", onKey);
        } catch {
          // Best-effort teardown.
        }
        renderer.destroy();
        resolve(index);
      };
      const onKey = (key: TuiKey): void => {
        if (key.ctrl && key.name === "c") {
          finish(2);
          return;
        }
        if (key.name === "up") {
          selected = moveHomeSelection(selected, "up");
          paintOptions();
          return;
        }
        if (key.name === "down") {
          selected = moveHomeSelection(selected, "down");
          paintOptions();
          return;
        }
        if (key.name === "return" || key.name === "linefeed" || key.name === "enter") {
          finish(selected);
          return;
        }
        if (key.name === "escape" || key.name === "q") {
          finish(2);
          return;
        }
        if (key.name === "1") {
          finish(0);
          return;
        }
        if (key.name === "2") {
          finish(1);
          return;
        }
        if (key.name === "3") {
          finish(2);
        }
      };
      renderer.keyInput.on("keypress", onKey);
    });
  } finally {
    try {
      await renderer.closed;
    } catch {
      // Teardown is best-effort.
    }
  }
}
