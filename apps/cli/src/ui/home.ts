// ui/home — RUSH CODE home screen (Главная). Block-art title, no I/O, no bg.
// Spec: 5-line block-art title + 3 options centered mid-screen:
// "Выбрать проект" / "Открыть директорию" / "Выйти".
// Navigation: arrows Up/Down + Enter, fallback digits 1-3 (see parseHomeInput).
// Transparency: ANSI fg open + fg reset only, never bg codes (reuses
// stripAnsi/ANSI_FG_CLOSE from chat.ts — no duplication).
// Title color: horizontal logo gradient (HOME_TITLE_STOPS, eyedropper from
// the RUSH CODE logo: orange → red → pink → purple → blue) across the whole
// block-art header. Two render paths share one column→color mapping:
//  - stdout (renderHomeScreen / formatHomeTitlePlain): ANSI 38;2 fg-only.
//    Both the TTY line-mode selector and the DEVBOX_NO_TUI/non-TTY fallback
//    print these strings, so both get the gradient (opt out: { color: false }).
//  - OpenTUI (startTuiHome in tui.ts): TextRenderable carries a single fg
//    per node and does not parse raw ANSI in content, so each art row is
//    split into plain chunks with an interpolated hex fg (homeArtSegments).
// Art: block centered as a unit (single left offset for all 5 lines),
// never truncated/wrapped — on narrow terminals (width < art width)
// lines stay left-aligned as-is.

import { ANSI_FG_CLOSE, stripAnsi } from "./chat.js";

//TODO: move to constants.ts (also used in chat.ts)
export const HOME_TITLE_ART = [
  "██████  ██    ██ ███████ ██   ██      ██████  ██████  ██████  ███████",
  "██   ██ ██    ██ ██      ██   ██     ██      ██    ██ ██   ██ ██",
  "██████  ██    ██ ███████ ███████     ██      ██    ██ ██   ██ █████",
  "██   ██ ██    ██      ██ ██   ██     ██      ██    ██ ██   ██ ██",
  "██   ██  ██████  ███████ ██   ██      ██████  ██████  ██████  ███████",
];

export const HOME_TITLE = [...HOME_TITLE_ART].join("\n");

//TODO: move to constants.ts (also used in chat.ts)
export const HOME_OPTIONS = ["Выбрать проект", "Открыть директорию", "Выйти"] as const;

//TODO: move to constants.ts (also used in chat.ts)
export const HOME_SIGNATURE = "by web2bizz team";

const ESC = String.fromCharCode(27);

/**
 * Logo gradient stops (eyedropper from the RUSH CODE logo, left → right):
 * orange-yellow → red-orange → pink → purple → blue-cyan.
 */
export const HOME_TITLE_STOPS = ["#FFB02E", "#FF4A2D", "#E93A6B", "#8B3DFF", "#2E9BFF"] as const;

export type HomeRgb = { r: number; g: number; b: number };

/** Parse #RRGGBB (or short #RGB) into 0-255 channels. */
export function hexToRgb(hex: string): HomeRgb {
  const body = hex.replace("#", "");
  const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Format 0-255 channels as uppercase #RRGGBB (OpenTUI ColorInput-compatible). */
export function rgbToHex({ r, g, b }: HomeRgb): string {
  const pad = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${pad(r)}${pad(g)}${pad(b)}`.toUpperCase();
}

/**
 * Piecewise-linear interpolation across hex stops, t in [0,1] clamped.
 * t=0 → first stop, t=1 → last stop.
 */
export function gradientColorAt(stops: readonly string[], t: number): HomeRgb {
  const clamped = Math.min(1, Math.max(0, t));
  const segs = Math.max(1, stops.length - 1);
  const pos = clamped * segs;
  const i = Math.min(segs - 1, Math.floor(pos));
  const f = pos - i;
  const a = hexToRgb(stops[i] ?? "#FFFFFF");
  const b = hexToRgb(stops[i + 1] ?? "#FFFFFF");
  return {
    r: Math.round(a.r + (b.r - a.r) * f),
    g: Math.round(a.g + (b.g - a.g) * f),
    b: Math.round(a.b + (b.b - a.b) * f),
  };
}

/** ANSI truecolor fg open (ESC built via fromCharCode — repo ASCII rule). */
function ansiFgTruecolor({ r, g, b }: HomeRgb): string {
  return `${ESC}[38;2;${r};${g};${b}m`;
}

/**
 * Horizontal logo gradient across the whole block-art title (fg-only
 * truecolor, no bg codes). The column→color mapping is shared by every row
 * (t = col / (blockWidth - 1), blockWidth = widest visible line), so color
 * stripes align vertically row-to-row. Spaces stay uncolored (fg on a space
 * is invisible) — stripAnsi() restores every line 1-в-1.
 */
export function gradientTitle(
  lines: readonly string[],
  stops: readonly string[] = HOME_TITLE_STOPS,
): string[] {
  const block = Math.max(1, ...lines.map((line) => widthOf(line)));
  const denom = Math.max(1, block - 1);
  return lines.map((line) =>
    [...line]
      .map((ch, col) =>
        ch === " " ? ch : `${ansiFgTruecolor(gradientColorAt(stops, col / denom))}${ch}${ANSI_FG_CLOSE}`,
      )
      .join(""),
  );
}

export type HomeArtSegment = { text: string; fg?: string };

/**
 * OpenTUI-native gradient: TextRenderable carries a single fg per node, so
 * each padded art row is split into plain chunks with an interpolated hex
 * fg. Chunk colors reuse the gradientTitle column mapping (same stops, same
 * t at chunk center), so the TUI stripes match the stdout ANSI gradient.
 * Leading centering pad stays a single uncolored chunk (no fg → default).
 * Empty art rows yield one blank chunk (mirrors the " " content fallback).
 */
export function homeArtSegments(
  width = 80,
  chunkCols = 6,
  stops: readonly string[] = HOME_TITLE_STOPS,
): HomeArtSegment[][] {
  const block = homeArtBlock(width).lines;
  const artWidth = Math.max(1, ...[...HOME_TITLE_ART].map((line) => [...line].length));
  const denom = Math.max(1, artWidth - 1);
  const size = Math.max(1, Math.floor(chunkCols) || 6);
  return block.map((line) => {
    if (line === "") return [{ text: " " }];
    const padMatch = /^ */.exec(line);
    const padLen = padMatch ? padMatch[0].length : 0;
    const segments: HomeArtSegment[] = [];
    if (padLen > 0) segments.push({ text: line.slice(0, padLen) });
    const art = line.slice(padLen);
    const chars = [...art];
    for (let start = 0; start < chars.length; start += size) {
      const piece = chars.slice(start, start + size);
      const center = start + (piece.length - 1) / 2;
      segments.push({ text: piece.join(""), fg: rgbToHex(gradientColorAt(stops, center / denom)) });
    }
    return segments;
  });
}

export type HomeOptionIndex = 0 | 1 | 2;

//TODO: move to constants.ts (also used in chat.ts)
export const HOME_SELECT_UP = "\u001b[A";
//TODO: move to constants.ts (also used in chat.ts)
export const HOME_SELECT_DOWN = "\u001b[B";


//TODO: move to a shared util (also used in chat.ts)
/** Visible width: ANSI-aware (strip ESC sequences before measuring). */
function widthOf(value: string): number {
  return [...stripAnsi(value)].length;
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
/** Center every line horizontally (no truncation, no bg; ANSI-aware width). */
export function centerLines(lines: string[], width: number): string[] {
  const safe = Math.max(20, Math.floor(width) || 80);
  return lines.map((line) => padCenter(line, safe));
}

/**
 * Verbatim block-art as a unit: one left offset for all 5 lines keeps columns
 * aligned (per-line centering drifts: 69/64/67 cols → 5 vs 8 pad at width 80).
 * Inner double spaces kept 1-в-1; narrow (artWidth >= width) → left-aligned
 * as-is, right-clip only. Shared by the stdout renderer, the plain helper
 * and the OpenTUI segment splitter so all three match 1-в-1.
 */
function homeArtBlock(width: number): { lines: string[]; artLeft: number } {
  const safe = Math.max(20, Math.floor(width) || 80);
  const artWidth = Math.max(...[...HOME_TITLE_ART].map((line) => widthOf(line)));
  const artLeft = artWidth >= safe ? 0 : Math.floor((safe - artWidth) / 2);
  return { lines: [...HOME_TITLE_ART].map((line) => " ".repeat(artLeft) + line), artLeft };
}

/**
 * Verbatim title block for the plain stdout fallback: block-art as a unit
 * (single left offset, no wrap/trim — inner double spaces kept 1-в-1).
 * Narrow width → left-aligned as-is (right-clip by the terminal, never
 * mid-line wrap). Colored with the logo gradient by default
 * (opt out: { color: false }).
 */
export function formatHomeTitlePlain(width = 80, opts?: { color?: boolean }): string {
  const block = homeArtBlock(width).lines;
  return (opts?.color === false ? block : gradientTitle(block)).join("\n");
}

/**
 * Render the home screen: blank padding above (vertical centering) + centered
 * block-art title as a unit (single left offset, no truncation/wrap;
 * narrow → left-aligned) with the horizontal logo gradient (fg-only truecolor;
 * opt out: { color: false }) + signature right below the art on the same left
 * edge (artLeft) + options below in the same left-aligned block. Selected
 * row gets the "›" marker. Pure function — caller writes via process.stdout
 * (never console.*).
 */
export function renderHomeScreen(width = 80, selected: number = 0, opts?: { color?: boolean }): string {
  const safe = Math.max(20, Math.floor(width) || 80);
  const sel = ((selected % HOME_OPTIONS.length) + HOME_OPTIONS.length) % HOME_OPTIONS.length;
  const { lines: artBlock, artLeft } = homeArtBlock(safe);
  const artColored = opts?.color === false ? artBlock : gradientTitle(artBlock);
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
    ...artColored,
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
