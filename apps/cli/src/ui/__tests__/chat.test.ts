// chat colors + full-width plain messages (no boxes).
// Run: bun test --isolate src (apps/cli).
// No raw ESC bytes in source (repo ASCII rule): ESC via fromCharCode.

import { describe, expect, test } from "bun:test";
import {
  AGENT_FG,
  ANSI_AGENT_OPEN,
  ANSI_FG_CLOSE,
  ANSI_USER_OPEN,
  USER_FG,
  formatAgentMessage,
  formatAgentPlain,
  formatUserMessage,
  formatUserPlain,
  hasBgCodes,
  resolveTerminalWidth,
  stripAnsi,
  terminalWidth,
  wrapMessage,
} from "../shared/chat.js";

const ESC = String.fromCharCode(27);
const BG_RE = new RegExp(`${ESC}\\[(?:4\\d|10\\d)m`);
const ANY_ANSI_RE = new RegExp(`${ESC}\\[`);

const BOX_CHARS = ["┌", "┐", "└", "┘", "│", "══", "╔", "╗", "╚", "╝"];

function expectNoBoxes(text: string): void {
  const plain = stripAnsi(text);
  for (const ch of BOX_CHARS) expect(plain).not.toContain(ch);
}

describe("chat width (terminal, not fixed 80)", () => {
  test("terminalWidth clamps + falls back", () => {
    expect(terminalWidth(120)).toBe(120);
    expect(terminalWidth(0)).toBe(80);
    expect(terminalWidth(Number.NaN)).toBe(80);
    expect(terminalWidth(5)).toBe(20);
  });

  test("resolveTerminalWidth prefers renderer, then stdout.columns", () => {
    expect(resolveTerminalWidth({ width: 132 })).toBe(132);
    expect(resolveTerminalWidth({ terminal: { width: 100 } })).toBe(100);
    expect(resolveTerminalWidth(undefined, 77)).toBe(77);
  });

  test("wrapMessage keeps every line within width", () => {
    for (const w of [40, 80, 120]) {
      const lines = wrapMessage("lorem ipsum dolor sit amet ".repeat(20), w);
      for (const line of lines) expect([...line].length).toBeLessThanOrEqual(w);
    }
  });

  test("messages wrap at terminal width (120, not 80)", () => {
    const long = "word ".repeat(60).trim();
    for (const line of stripAnsi(formatUserMessage(long, 120)).split("\n")) {
      expect([...line].length).toBeLessThanOrEqual(120);
    }
    for (const line of stripAnsi(formatAgentMessage(long, 120)).split("\n")) {
      expect([...line].length).toBeLessThanOrEqual(120);
    }
  });
});

describe("chat plain (no boxes)", () => {
  test("user + agent plain contain no box frames", () => {
    expectNoBoxes(formatUserMessage("hello cli", 80));
    expectNoBoxes(formatAgentMessage("hello from opencode", 80));
    expectNoBoxes(formatUserPlain("hello cli", 80));
    expectNoBoxes(formatAgentPlain("hello from opencode", 80));
  });

  test("plain keeps role prefixes", () => {
    expect(stripAnsi(formatUserMessage("hi", 80))).toContain("you ›");
    expect(stripAnsi(formatAgentMessage("hi", 80))).toContain("agent ›");
  });
});

describe("chat color (fg only, transparency)", () => {
  test("user cyan / agent green, fg pair fixed", () => {
    expect(USER_FG).toBe("cyan");
    expect(AGENT_FG).toBe("green");
  });

  test("stdout fallback uses ANSI fg open + fg reset, no bg codes", () => {
    const user = formatUserMessage("hi", 80);
    const agent = formatAgentMessage("hi", 80);
    expect(user).toContain(ANSI_USER_OPEN);
    expect(agent).toContain(ANSI_AGENT_OPEN);
    expect(user).toContain(ANSI_FG_CLOSE);
    expect(agent).toContain(ANSI_FG_CLOSE);
    expect(hasBgCodes(user)).toBe(false);
    expect(hasBgCodes(agent)).toBe(false);
    expect(BG_RE.test(user)).toBe(false);
    expect(BG_RE.test(agent)).toBe(false);
  });

  test("TUI plain carries no ANSI (fg comes from TextRenderable)", () => {
    expect(ANY_ANSI_RE.test(formatUserPlain("hi", 80))).toBe(false);
    expect(ANY_ANSI_RE.test(formatAgentPlain("hi", 80))).toBe(false);
  });
});
