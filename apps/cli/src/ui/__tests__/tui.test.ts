// tui transparency + startup-order + gate tests (no renderer instantiated:
// @opentui/core native bindings stay unloaded — source + pure helpers only).
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizePastedText,
  shouldUseTui,
  TUI_HISTORY_CAP,
  TUI_INPUT_MAX_LENGTH,
  tuiStartupOrder,
} from "../tui.js";

const TUI_SOURCE = readFileSync(join(import.meta.dir, "..", "tui.ts"), "utf8");

describe("tui transparency (terminal shows through)", () => {
  test("render code sets no backdrop: no bg/fill/Rect tokens", () => {
    expect(TUI_SOURCE).not.toMatch(/backgroundColor|setBackgroundColor/);
    expect(TUI_SOURCE).not.toMatch(/\bbackground\b/i);
    expect(TUI_SOURCE).not.toMatch(/\bfill\b/i);
    expect(TUI_SOURCE).not.toMatch(/\bRect\b/);
    expect(TUI_SOURCE).not.toMatch(/[{,\s]bg\s*:/);
  });

  test("content flows through OpenTUI text nodes (box.ts stays the content)", () => {
    expect(TUI_SOURCE).toContain("TextRenderable");
    expect(TUI_SOURCE).toContain("ScrollBoxRenderable");
    expect(TUI_SOURCE).toContain("InputRenderable");
    expect(TUI_SOURCE).toContain("stickyStart");
  });

  test("input submits via OpenTUI ENTER event and stays focused at the bottom", () => {
    expect(TUI_SOURCE).toContain("InputRenderableEvents");
    expect(TUI_SOURCE).toContain("ENTER");
    expect(TUI_SOURCE).toContain("space-between");
    expect(TUI_SOURCE).toContain("stickyStart");
  });

  test("history is capped so the input never scrolls off", () => {
    expect(TUI_HISTORY_CAP).toBeGreaterThan(0);
    expect(TUI_SOURCE).toContain("TUI_HISTORY_CAP");
  });
});

describe("tui startup order (clear first, prompt last)", () => {
  test("order is clear → greeting → history → prompt", () => {
    expect(tuiStartupOrder()).toEqual(["clear", "greeting", "history", "prompt"]);
  });
});

describe("tui gate (non-TTY/--help/CI keep the stdout fallback)", () => {
  test("TTY REPL route enables the TUI", () => {
    expect(shouldUseTui([], true, {})).toBe(true);
    expect(shouldUseTui(["repl"], true, {})).toBe(true);
  });

  test("--help/version/non-TTY never enter the TUI", () => {
    expect(shouldUseTui(["--help"], true, {})).toBe(false);
    expect(shouldUseTui(["--version"], true, {})).toBe(false);
    expect(shouldUseTui([], false, {})).toBe(false);
    expect(shouldUseTui(["repl"], false, {})).toBe(false);
  });

  test("DEVBOX_NO_TUI=1 forces the stdout fallback", () => {
    expect(shouldUseTui([], true, { DEVBOX_NO_TUI: "1" })).toBe(false);
    expect(shouldUseTui([], true, { DEVBOX_NO_TUI: "" })).toBe(true);
  });

  test("readline fallback owns paste when TUI is off (no native bindings needed)", () => {
    // cli.ts: shouldUseTui==false → startReadlineRepl (readline keeps
    // Ctrl+V/Shift+Ins/bracketed paste natively). Gate contract only.
    expect(shouldUseTui([], true, { DEVBOX_NO_TUI: "1" })).toBe(false);
    expect(TUI_SOURCE).toContain("DEVBOX_NO_TUI");
  });
});

describe("tui paste (Ctrl+V / Shift+Ins / bracketed / multiline)", () => {
  const START = String.fromCharCode(27) + "[200~";
  const END = String.fromCharCode(27) + "[201~";

  test("paste-safe maxLength is raised and passed to InputRenderable", () => {
    expect(TUI_INPUT_MAX_LENGTH).toBeGreaterThan(1000);
    expect(TUI_SOURCE).toContain("maxLength");
    expect(TUI_SOURCE).toContain("TUI_INPUT_MAX_LENGTH");
  });

  test("bracketed markers stripped, multiline joined to one line", () => {
    expect(normalizePastedText(`${START}hello${END}`)).toBe("hello");
    expect(normalizePastedText("line1\nline2\r\nline3\rlast")).toBe("line1 line2 line3 last");
    expect(normalizePastedText(`${START} multi  \n  paste ${END}`)).toBe("multi paste");
  });

  test("C0 controls stripped, tabs to spaces, capped at maxLength", () => {
    const c0 = `a${String.fromCharCode(0)}b${String.fromCharCode(31)}c${String.fromCharCode(127)}d`;
    expect(normalizePastedText(c0)).toBe("abcd");
    expect(normalizePastedText("a\tb")).toBe("a b");
    const long = "x".repeat(TUI_INPUT_MAX_LENGTH + 50);
    expect([...normalizePastedText(long)].length).toBe(TUI_INPUT_MAX_LENGTH);
    expect(normalizePastedText("  hello  ")).toBe("hello");
  });

  test("ENTER path normalizes + refocuses (paste keeps flowing after focus loss)", () => {
    expect(TUI_SOURCE).toContain("normalizePastedText");
    const refocusHits = TUI_SOURCE.split("refocus()").length - 1;
    expect(refocusHits).toBeGreaterThanOrEqual(3);
    expect(TUI_SOURCE).toContain("input.focus()");
    expect(TUI_SOURCE).toContain("input.value = \"\"");
  });
});
