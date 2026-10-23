// ui/box — ASCII-only renderer (no I/O, no fs, no env).
// Chars: box ┌─┐│└─┘├┤┬┴┼, header ══, status ✓ ✗ ⚠ → ●, separator ──, table │.

export const BOX_WIDTH = 80;

const TOP_LEFT = "┌";
const TOP_RIGHT = "┐";
const BOTTOM_LEFT = "└";
const BOTTOM_RIGHT = "┘";
const HORIZONTAL = "─";
const VERTICAL = "│";
const DOUBLE_HORIZONTAL = "═";

function padEndAscii(value: string, width: number): string {
  const len = [...value].length;
  if (len >= width) return value;
  return value + " ".repeat(width - len);
}

function truncateAscii(value: string, width: number): string {
  const chars = [...value];
  if (chars.length <= width) return value;
  if (width <= 1) return chars.slice(0, width).join("");
  return chars.slice(0, width - 1).join("") + "…";
}

function innerWidth(width: number): number {
  return Math.max(width - 2, 1);
}

/** Single box around lines. Width includes borders. */
export function box(lines: string[], width: number = BOX_WIDTH): string {
  const inner = innerWidth(width);
  const top = TOP_LEFT + HORIZONTAL.repeat(inner) + TOP_RIGHT;
  const bottom = BOTTOM_LEFT + HORIZONTAL.repeat(inner) + BOTTOM_RIGHT;
  const body = lines.map((line) => {
    const clean = truncateAscii(line, inner);
    return VERTICAL + padEndAscii(clean, inner) + VERTICAL;
  });
  return [top, ...body, bottom].join("\n");
}

/** Header rule: ══ line with centered title. */
export function header(title: string, width: number = BOX_WIDTH): string {
  const clean = truncateAscii(title, innerWidth(width));
  const rule = DOUBLE_HORIZONTAL.repeat(2) + " " + clean + " ";
  return truncateAscii(rule, width);
}

/** Separator: ── full width. */
export function separator(width: number = BOX_WIDTH): string {
  return HORIZONTAL.repeat(width);
}

/** Success box: ✓ prefix on each line. */
export function okBox(lines: string[], width: number = BOX_WIDTH): string {
  return box(lines.map((l) => `✓ ${l}`), width);
}

/** Split a long line into width-safe chunks (no … loss for diagnostics). */
export function wrapAscii(value: string, width: number): string[] {
  const chars = [...value];
  if (chars.length <= width) return [value];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += width) {
    out.push(chars.slice(i, i + width).join(""));
  }
  return out.length > 0 ? out : [""];
}

/** Error box: ✗ prefix on first line, indented rest. Wraps (never …-cuts). */
export function errorBox(message: string, hint?: string, width: number = BOX_WIDTH): string {
  const inner = innerWidth(width);
  const lines: string[] = [];
  for (const chunk of wrapAscii(`✗ ${message}`, inner)) lines.push(chunk);
  if (hint) {
    for (const hintLine of hint.split("\n")) {
      for (const chunk of wrapAscii(`  → ${hintLine}`, inner)) lines.push(chunk);
    }
  }
  // Wrap-aware: bypass box() truncation (box keeps … for generic boxes).
  const top = TOP_LEFT + HORIZONTAL.repeat(inner) + TOP_RIGHT;
  const bottom = BOTTOM_LEFT + HORIZONTAL.repeat(inner) + BOTTOM_RIGHT;
  const body = lines.map((line) => VERTICAL + padEndAscii(line, inner) + VERTICAL);
  return [top, ...body, bottom].join("\n");
}

/** Warning box: ⚠ prefix. */
export function warnBox(lines: string[], width: number = BOX_WIDTH): string {
  return box(lines.map((l) => `⚠ ${l}`), width);
}

export type TableRow = string[];

/** ASCII table with │ separators. No column auto-stretch beyond width. */
export function table(headers: TableRow, rows: TableRow[], width: number = BOX_WIDTH): string {
  const colCount = headers.length;
  const colWidths = headers.map((h, i) => {
    let max = [...h].length;
    for (const row of rows) {
      const cell = row[i] ?? "";
      max = Math.max(max, [...cell].length);
    }
    return max;
  });
  // Shrink proportionally when the table exceeds the inner width.
  const separators = colCount + 1; // │ borders + dividers
  const total = colWidths.reduce((a, b) => a + b, 0) + separators + colCount * 2;
  let widths = [...colWidths];
  if (total > width) {
    let overflow = total - width;
    let idx = 0;
    while (overflow > 0) {
      const widest = widths.indexOf(Math.max(...widths));
      if (widths[widest] > 4) {
        widths[widest] -= 1;
        overflow -= 1;
      } else {
        idx += 1;
        if (idx > colCount * 10) break;
      }
    }
  }
  const renderRow = (cells: TableRow): string => {
    const parts = cells.map((cell, i) => {
      const w = widths[i] ?? 4;
      return " " + padEndAscii(truncateAscii(cell ?? "", w), w) + " ";
    });
    return VERTICAL + parts.join(VERTICAL) + VERTICAL;
  };
  const divider =
    "├" + widths.map((w) => HORIZONTAL.repeat(w + 2)).join("┼") + "┤";
  const top = "┌" + widths.map((w) => HORIZONTAL.repeat(w + 2)).join("┬") + "┐";
  const bottom = "└" + widths.map((w) => HORIZONTAL.repeat(w + 2)).join("┴") + "┘";
  return [top, renderRow(headers), divider, ...rows.map(renderRow), bottom].join("\n");
}

/** Greeting banner (double-line outer frame per spec). */
export function greeting(version: string): string {
  const inner = 38;
  const row = (content: string): string => "║" + padEndAscii(truncateAscii(content, inner), inner) + "║";
  return [
    "╔" + "═".repeat(inner) + "╗",
    row(`  ◆ DEVBOX CLI  v${version}`),
    row("  prompt > _  [@file] [/agent]"),
    "╚" + "═".repeat(inner) + "╝",
  ].join("\n");
}

/** Status line: ● / → helpers keep symbols consistent. */
export function statusLine(status: "ok" | "err" | "warn" | "run", text: string): string {
  const mark = status === "ok" ? "✓" : status === "err" ? "✗" : status === "warn" ? "⚠" : "●";
  return `${mark} ${text}`;
}
