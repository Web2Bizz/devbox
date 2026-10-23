// ui/chat — full-width plain chat messages (no boxes, fg-only color).
// Transparency: ANSI uses fg open + fg reset only (no bg codes 40-47/100-107).
// TUI uses TextRenderable fg only, width 100%.
// No raw ESC bytes in source (repo ASCII rule): ESC built via fromCharCode.

const ESC = String.fromCharCode(27);

export const USER_FG = "cyan";
export const AGENT_FG = "green";

export const ANSI_USER_OPEN = `${ESC}[36m`;
export const ANSI_AGENT_OPEN = `${ESC}[32m`;
export const ANSI_FG_CLOSE = `${ESC}[39m`;

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const BG_CODE_RE = new RegExp(`${ESC}\\[(?:4\\d|10\\d)m`);

export function hasBgCodes(text: string): boolean {
  return BG_CODE_RE.test(text);
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Terminal width: explicit override → stdout.columns → fallback. Clamped 20..1000. */
export function terminalWidth(columns?: number, fallback = 80): number {
  const raw =
    typeof columns === "number" && Number.isFinite(columns)
      ? columns
      : typeof process !== "undefined"
        ? (process.stdout?.columns ?? fallback)
        : fallback;
  if (!Number.isFinite(raw) || (raw as number) <= 0) return fallback;
  return Math.max(20, Math.min(1000, Math.floor(raw as number)));
}

/** Resolve width from an OpenTUI renderer when available, else stdout.columns. */
export function resolveTerminalWidth(renderer?: unknown, fallback = 80): number {
  const candidate =
    (renderer as { width?: unknown } | undefined)?.width ??
    (renderer as { terminal?: { width?: unknown } } | undefined)?.terminal?.width ??
    (renderer as { stdout?: { columns?: unknown } } | undefined)?.stdout?.columns ??
    (typeof process !== "undefined" ? process.stdout?.columns : undefined);
  return terminalWidth(typeof candidate === "number" ? candidate : fallback, fallback);
}

/** Word-wrap preserving explicit newlines; long words hard-break. */
export function wrapMessage(text: string, width: number): string[] {
  const safe = Math.max(20, Math.floor(width) || 80);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    const words = paragraph.split(/ +/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if ([...word].length > safe) {
        if (line) {
          out.push(line);
          line = "";
        }
        const chars = [...word];
        for (let i = 0; i < chars.length; i += safe) {
          out.push(chars.slice(i, i + safe).join(""));
        }
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if ([...next].length > safe) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out.length > 0 ? out : [""];
}

const USER_PREFIX = "you › ";
const AGENT_PREFIX = "agent › ";

function colorizeLines(lines: string[], open: string): string {
  return lines.map((l) => `${open}${l === "" ? " " : l}${ANSI_FG_CLOSE}`).join("\n");
}

/** User prompt: cyan fg, plain wrap at full terminal width, no boxes. */
export function formatUserMessage(text: string, width: number = terminalWidth()): string {
  const safe = terminalWidth(width);
  const avail = Math.max(20, safe - [...USER_PREFIX].length);
  const wrapped = wrapMessage(text.trim() === "" ? " " : text, avail);
  const prefixed = wrapped.map((line, i) =>
    i === 0 ? `${USER_PREFIX}${line}` : `${" ".repeat([...USER_PREFIX].length)}${line}`,
  );
  return colorizeLines(prefixed, ANSI_USER_OPEN);
}

/** Agent reply: green fg, plain wrap at full terminal width, no boxes. */
export function formatAgentMessage(text: string, width: number = terminalWidth()): string {
  const safe = terminalWidth(width);
  const avail = Math.max(20, safe - [...AGENT_PREFIX].length);
  const wrapped = wrapMessage(text.trim() === "" ? " " : text, avail);
  const prefixed = wrapped.map((line, i) =>
    i === 0 ? `${AGENT_PREFIX}${line}` : `${" ".repeat([...AGENT_PREFIX].length)}${line}`,
  );
  return colorizeLines(prefixed, ANSI_AGENT_OPEN);
}

/** Plain (no ANSI) user lines for the TUI history (fg comes from TextRenderable). */
export function formatUserPlain(text: string, width: number = terminalWidth()): string {
  const safe = terminalWidth(width);
  const avail = Math.max(20, safe - [...USER_PREFIX].length);
  const wrapped = wrapMessage(text.trim() === "" ? " " : text, avail);
  return wrapped
    .map((line, i) => (i === 0 ? `${USER_PREFIX}${line}` : `${" ".repeat([...USER_PREFIX].length)}${line}`))
    .join("\n");
}

/** Plain (no ANSI) agent lines for the TUI history (fg comes from TextRenderable). */
export function formatAgentPlain(text: string, width: number = terminalWidth()): string {
  const safe = terminalWidth(width);
  const avail = Math.max(20, safe - [...AGENT_PREFIX].length);
  const wrapped = wrapMessage(text.trim() === "" ? " " : text, avail);
  return wrapped
    .map((line, i) => (i === 0 ? `${AGENT_PREFIX}${line}` : `${" ".repeat([...AGENT_PREFIX].length)}${line}`))
    .join("\n");
}

/** TUI text options for chat roles (fg-only, full width, no bg backdrop). */
export function userTextOptions(): { fg: string; width: string } {
  return { fg: USER_FG, width: "100%" };
}

export function agentTextOptions(): { fg: string; width: string } {
  return { fg: AGENT_FG, width: "100%" };
}
