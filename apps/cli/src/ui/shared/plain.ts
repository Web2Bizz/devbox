// ui/shared/plain — plain-text renderer (no I/O, no fs, no env).
// Stdout is plain text; TUI renders natively via screens/ReplScreen.tsx.

export type TableRow = string[];

function padPlain(value: string, width: number): string {
  const len = [...value].length;
  if (len >= width) return value;
  return value + " ".repeat(width - len);
}

function truncatePlain(value: string, width: number): string {
  const chars = [...value];
  if (chars.length <= width) return value;
  if (width <= 1) return chars.slice(0, width).join("");
  return chars.slice(0, width - 1).join("") + "…";
}

/** Plain header: title as-is (no double-line rule). */
export function headerText(title: string): string {
  return title;
}

/** Plain error: ✗ prefix + indented hints (multiline hint → per-line prefix). */
export function errorText(message: string, hint?: string): string {
  const lines: string[] = [`✗ ${message}`];
  if (hint) {
    for (const hintLine of hint.split("\n")) {
      lines.push(`  → ${hintLine}`);
    }
  }
  return lines.join("\n");
}

/** Plain table: padded cells joined by two spaces, no frames/divider. */
export function tableText(headers: TableRow, rows: TableRow[], width = 80): string {
  const colCount = headers.length;
  const colWidths = headers.map((h, i) => {
    let max = [...h].length;
    for (const row of rows) {
      const cell = row[i] ?? "";
      max = Math.max(max, [...cell].length);
    }
    return max;
  });
  // Shrink proportionally when the plain row exceeds the width.
  const total = colWidths.reduce((a, b) => a + b, 0) + Math.max(colCount - 1, 0) * 2;
  let widths = [...colWidths];
  if (total > width) {
    let overflow = total - width;
    let idx = 0;
    while (overflow > 0) {
      const widest = widths.indexOf(Math.max(...widths));
      if (widths[widest]! > 4) {
        widths[widest]! -= 1;
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
      return padPlain(truncatePlain(cell ?? "", w), w);
    });
    return parts.join("  ");
  };
  return [renderRow(headers), ...rows.map(renderRow)].join("\n");
}

/** Greeting lines (no frame). */
export function greetingLines(version: string): string[] {
  return [
    `  ◆ DEVBOX CLI v${version}`,
    "  prompt > _  [@file] [/agent]",
    "  /help /exit  type /help, /exit",
    "  refs: @path/to/file (.. denied)",
  ];
}

/** Status line: ● / ✓ / ✗ / ⚠ marker (not a frame — stays). */
export function statusLine(status: "ok" | "err" | "warn" | "run", text: string): string {
  const mark = status === "ok" ? "✓" : status === "err" ? "✗" : status === "warn" ? "⚠" : "●";
  return `${mark} ${text}`;
}
