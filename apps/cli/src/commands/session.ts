// commands/session — TUI session types (no React import).

/** How many history lines the TUI keeps before trimming the oldest. */
export const TUI_HISTORY_CAP = 400;

/** Frame budget for the REPL renderer (demand-driven; frames on mutation). */
export const TUI_TARGET_FPS = 30;

/** Startup order mirror: reset first, single greeting frame on top, input last. */
export function tuiStartupOrder(): Array<"clear" | "greeting" | "history" | "prompt"> {
  return ["clear", "greeting", "history", "prompt"];
}


export type TuiSession = {
  print: (text: string, opts?: { fg?: string }) => void;
  printUser: (text: string) => void;
  printAgent: (text: string) => void;
  /** Verbatim block-art title: no wrap/trim, left-align + right-clip when narrow. */
  printTitle: (text: string) => void;
  /** Structural header: kind "header" (native row, yellow fg). */
  header: (title: string) => void;
  /** Structural box: kind "box" (plain <text> rows, no frames). */
  box: (lines: string[]) => void;
  /** Structural error: kind "error" (`${message}\n${hint}`, red fg). */
  error: (message: string, hint?: string) => void;
  /** Structural table: kind "table" (JSON {headers, rows}, native rows). */
  table: (headers: string[], rows: string[][]) => void;
  spin: (label: string) => () => void;
  /** Full terminal width (renderer → stdout.columns → 80). */
  width: () => number;
};

export type TuiLineResult = { exit: boolean };
