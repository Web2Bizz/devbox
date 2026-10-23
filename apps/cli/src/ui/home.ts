// ui/home — RUSH CODE home screen (Главная). Block-art title, no I/O, no bg.
// Spec: 5-line block-art title + 3 options centered mid-screen:
// "Выбрать проект" / "Открыть директорию" / "Выйти".
// Navigation: arrows Up/Down + Enter, fallback digits 1-3 (see parseHomeInput).
// Transparency: no ANSI bg codes here (fg-only lives in chat.ts); this module
// emits plain centered lines only, so both TTY raw-mode selector and the
// stdout fallback (DEVBOX_NO_TUI=1 / non-TTY / CI) share the same renderer.
// Art: block centered as a unit (single left offset for all 5 lines),
// never truncated/wrapped — on narrow terminals (width < art width)
// lines stay left-aligned as-is.

//TODO: move to constants.ts (also used in chat.ts)
export const HOME_TITLE_ART = [
  "██████  ██    ██ ███████ ██   ██      ██████  ██████  ██████  ███████",
  "██   ██ ██    ██ ██      ██   ██     ██      ██    ██ ██   ██ ██",
  "██████  ██    ██ ███████ ███████     ██      ██    ██ ██   ██ █████",
  "██   ██ ██    ██      ██ ██   ██     ██      ██    ██ ██   ██ ██",
  "██   ██  ██████  ███████ ██   ██      ██████  ██████  ██████  ███████",
  ""
] as const;

export const HOME_TITLE = [...HOME_TITLE_ART].join("\n");

//TODO: move to constants.ts (also used in chat.ts)
export const HOME_OPTIONS = ["Выбрать проект", "Открыть директорию", "Выйти"] as const;

//TODO: move to constants.ts (also used in chat.ts)
export const HOME_SIGNATURE = "by web2bizz team";

export type HomeOptionIndex = 0 | 1 | 2;

//TODO: move to constants.ts (also used in chat.ts)
export const HOME_SELECT_UP = "\u001b[A";
//TODO: move to constants.ts (also used in chat.ts)
export const HOME_SELECT_DOWN = "\u001b[B";


//TODO: move to a shared util (also used in chat.ts)
function widthOf(value: string): number {
  return [...value].length;
}

/** OpenTUI verbatim options for block-art title: no wrap, no cut (right-clip only). */
export function titleTextOptions(): { wrapMode: string; truncate: boolean; width: string } {
  return { wrapMode: "none", truncate: false, width: "100%" };
}

//TODO: move to a shared util (also used in chat.ts)
function padCenter(line: string, width: number): string {
  const len = widthOf(line);
  if (len >= width) return line;
  const left = Math.floor((width - len) / 2);
  return " ".repeat(left) + line;
}

//TODO: move to a shared util (also used in chat.ts)
/** Center every line horizontally (no truncation, no bg, no ANSI). */
export function centerLines(lines: string[], width: number): string[] {
  const safe = Math.max(20, Math.floor(width) || 80);
  return lines.map((line) => padCenter(line, safe));
}

/**
 * Verbatim title block for the plain stdout fallback: centered line-by-line,
 * no wrap/trim — inner double spaces kept 1-в-1. Narrow width → left-aligned
 * as-is (right-clip by the terminal, never mid-line wrap).
 */
export function formatHomeTitlePlain(width = 80): string {
  const safe = Math.max(20, Math.floor(width) || 80);
  return centerLines([...HOME_TITLE_ART], safe).join("\n");
}

/**
 * Render the home screen: blank padding above (vertical centering) + centered
 * block-art title as a unit (single left offset, no truncation/wrap;
 * narrow → left-aligned) + signature right below the art on the same left
 * edge (artLeft) + options below in the same left-aligned block. Selected
 * row gets the "›" marker. Pure function — caller writes via process.stdout
 * (never console.*).
 */
export function renderHomeScreen(width = 80, selected: number = 0): string {
  const safe = Math.max(20, Math.floor(width) || 80);
  const sel = ((selected % HOME_OPTIONS.length) + HOME_OPTIONS.length) % HOME_OPTIONS.length;
  // Verbatim block-art: one left offset for all 5 lines keeps columns aligned
  // (per-line centering drifts: 69/64/67 cols → 5 vs 8 pad at width 80).
  // Inner double spaces kept 1-в-1; narrow → left-aligned, right-clip only.
  const artWidth = Math.max(...[...HOME_TITLE_ART].map(widthOf));
  const artLeft = artWidth >= safe ? 0 : Math.floor((safe - artWidth) / 2);
  const artBlock = [...HOME_TITLE_ART].map((line) => " ".repeat(artLeft) + line);
  const head: string[] = ["", ""];
  const gap: string[] = [""];
  const signatureLine = " ".repeat(artLeft) + HOME_SIGNATURE;
  const optionLines: string[] = HOME_OPTIONS.map((opt, i) => {
    const marker = i === sel ? "› " : "  ";
    return `${" ".repeat(artLeft)}${marker}${i + 1}. ${opt}`;
  });
  const tail: string[] = ["", "↑↓ + Enter · или 1-3"];
  return [
    ...centerLines(head, safe),
    ...artBlock,
    signatureLine,
    ...centerLines(gap, safe),
    ...optionLines,
    ...centerLines(tail, safe),
  ].join("\n");
}

/** Move selection with wrap-around (arrow navigation). */
export function moveHomeSelection(current: number, dir: "up" | "down"): HomeOptionIndex {
  const n = HOME_OPTIONS.length;
  const next = dir === "up" ? current - 1 : current + 1;
  return (((next % n) + n) % n) as HomeOptionIndex;
}

export type HomeInput =
  | { kind: "select"; index: HomeOptionIndex }
  | { kind: "move"; dir: "up" | "down" }
  | { kind: "invalid" };

/**
 * Parse one fallback line (digits 1-3) or a raw arrow escape.
 * "1"/"2"/"3" (also "выбрать проект" exact text, case-insensitive trim) →
 * select; ESC[A / ESC[B → move; empty → invalid (caller re-prompts).
 */
export function parseHomeInput(raw: string): HomeInput {
  const line = raw.trim().toLowerCase();
  if (line === "1" || line === HOME_OPTIONS[0].toLowerCase()) return { kind: "select", index: 0 };
  if (line === "2" || line === HOME_OPTIONS[1].toLowerCase()) return { kind: "select", index: 1 };
  if (line === "3" || line === HOME_OPTIONS[2].toLowerCase()) return { kind: "select", index: 2 };
  if (raw === HOME_SELECT_UP || line === "up" || line === "к") return { kind: "move", dir: "up" };
  if (raw === HOME_SELECT_DOWN || line === "down") return { kind: "move", dir: "down" };
  return { kind: "invalid" };
}

/** True when stdout fallback must skip raw-mode arrows (no TTY / CI / flag). */
export function shouldUseHomeFallback(
  args: string[],
  isTTY: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((env.DEVBOX_NO_TUI ?? "").trim() === "1") return true;
  if (!isTTY) return true;
  if (args.includes("--help") || args.includes("-h")) return true;
  if (args.includes("--version") || args.includes("-V")) return true;
  return false;
}
