// tui transparency + startup-order + gate tests (no renderer instantiated:
// @opentui/core native bindings stay unloaded — source + pure helpers only).
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  homeArtLines,
  homeOptionLine,
  normalizePastedText,
  shouldUseTui,
  TUI_HISTORY_CAP,
  TUI_INPUT_MAX_LENGTH,
  tuiStartupOrder,
} from "../tui.js";
import { homeArtSegments } from "../home.js";

const TUI_SOURCE = readFileSync(join(import.meta.dir, "..", "tui.ts"), "utf8");

describe("tui transparency (terminal shows through)", () => {
  test("render code sets no backdrop: no bg/fill/Rect tokens", () => {
    expect(TUI_SOURCE).not.toMatch(/backgroundColor|setBackgroundColor/);
    expect(TUI_SOURCE).not.toMatch(/\bbackground\b/i);
    expect(TUI_SOURCE).not.toMatch(/\bfill\b/i);
    expect(TUI_SOURCE).not.toMatch(/\bRect\b/);
    expect(TUI_SOURCE).not.toMatch(/[{,\s]bg\s*:/);
  });

  test("chat history is full terminal width (100%, renderer → stdout.columns)", () => {
    expect(TUI_SOURCE).toContain('width: "100%"');
    expect(TUI_SOURCE).toContain("resolveTerminalWidth");
    expect(TUI_SOURCE).toContain("session.width");
    expect(TUI_SOURCE).not.toContain("BOX_WIDTH");
  });

  test("chat messages carry fg-only color (user cyan, agent green, no bg)", () => {
    expect(TUI_SOURCE).toContain("USER_FG");
    expect(TUI_SOURCE).toContain("AGENT_FG");
    expect(TUI_SOURCE).toContain("printUser");
    expect(TUI_SOURCE).toContain("printAgent");
    expect(TUI_SOURCE).toContain("fg: USER_FG");
    expect(TUI_SOURCE).toContain("fg: AGENT_FG");
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

  test("startup prints a single greeting frame (no second hint box)", () => {
    expect(TUI_SOURCE).toContain("session.print(options.greeting)");
    expect(TUI_SOURCE).not.toContain("options.hints");
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

describe("tui title (verbatim block-art, no space collapse)", () => {
  test("title has a dedicated verbatim path (printTitle + titleTextOptions)", () => {
    expect(TUI_SOURCE).toContain("printTitle");
    expect(TUI_SOURCE).toContain("titleTextOptions");
    expect(TUI_SOURCE).toContain("wrapMode");
    expect(TUI_SOURCE).toContain("truncate");
    // Title path never word-splits: chat wrap helper stays out of tui.ts.
    expect(TUI_SOURCE).not.toContain("wrapMessage");
    expect(TUI_SOURCE).not.toContain("printUserPlain");
    expect(TUI_SOURCE).not.toContain("printAgentPlain");
  });

  test("verbatim opts are wrapMode none + truncate false (right-clip, no mid wrap)", () => {
    const homeSource = readFileSync(join(import.meta.dir, "..", "home.ts"), "utf8");
    expect(homeSource).toContain('wrapMode: "none"');
    expect(homeSource).toContain("truncate: false");
  });
});

describe("tui home (Главная без мигания: арт статичен, маркер инкрементален)", () => {
  test("startTuiHome exported; art drawn once via the title path, options are separate nodes", () => {
    expect(TUI_SOURCE).toContain("startTuiHome");
    expect(TUI_SOURCE).toContain("HOME_TITLE_ART");
    expect(TUI_SOURCE).toContain("titleTextOptions");
    expect(TUI_SOURCE).toContain("artNodes");
    expect(TUI_SOURCE).toContain("optionNodes");
  });

  test("arrows repaint only the option rows (marker › moves, art nodes untouched, no clear)", () => {
    expect(TUI_SOURCE).toContain("moveHomeSelection");
    expect(TUI_SOURCE).toContain("paintOptions");
    expect(TUI_SOURCE).toContain("node.content = homeOptionLine");
    // Home selector never clears the screen per keypress (old flicker path).
    const homeFn = TUI_SOURCE.slice(TUI_SOURCE.indexOf("startTuiHome"));
    expect(homeFn).not.toContain("clearScreen");
    expect(homeFn).not.toContain("renderHomeScreen");
    // Only option nodes are mutated; art nodes are created once and never reassigned.
    expect(homeFn).not.toMatch(/artNodes\[[^\]]*\]\s*\.content\s*=/);
    expect(homeFn).not.toContain("artNodes.forEach");
  });

  test("selector changes only the marker: same width, same labels, › moves", () => {
    const a0 = homeOptionLine(0, 0, 80);
    const a1 = homeOptionLine(0, 1, 80);
    expect(a0).toContain("› 1. Выбрать проект");
    expect(a1).not.toContain("›");
    expect(a1).toContain("1. Выбрать проект");
    expect(homeOptionLine(1, 1, 80)).toContain("› 2. Открыть директорию");
    expect(homeOptionLine(2, 2, 80)).toContain("› 3. Выйти");
    // Marker-only diff: stripping the marker prefix equalizes the rows.
    const strip = (s: string): string => s.replace("›", " ").trim();
    expect(strip(a0)).toBe(strip(a1));
    expect(strip(homeOptionLine(1, 1, 80))).toBe(strip(homeOptionLine(1, 0, 80)));
  });

  test("art block is stable across selection (no reprint on arrows)", () => {
    expect(homeArtLines(80)).toEqual(homeArtLines(80));
    for (const line of homeArtLines(80)) {
      expect(line).not.toContain("›");
    }
    // Options never leak into the art block.
    const art = homeArtLines(80).join("\n");
    expect(art).not.toContain("Выбрать проект");
    expect(art).not.toContain("Открыть директорию");
    expect(art).not.toContain("Выйти");
  });

  test("home keeps transparency (fg-only, no bg/backdrop)", () => {
    const homeFn = TUI_SOURCE.slice(TUI_SOURCE.indexOf("startTuiHome"));
    expect(homeFn).not.toMatch(/backgroundColor|setBackgroundColor/);
    expect(homeFn).not.toMatch(/[{,\s]bg\s*:/);
  });

  test("title gradient is OpenTUI-native (row chunks with hex fg, no ANSI in content)", () => {
    const homeFn = TUI_SOURCE.slice(TUI_SOURCE.indexOf("startTuiHome"));
    // TextRenderable carries a single fg per node: one "row" box per art
    // line, plain chunks with interpolated hex fg (ANSI would render literally).
    expect(TUI_SOURCE).toContain("homeArtSegments");
    expect(homeFn).toContain("homeArtSegments");
    expect(homeFn).toContain('flexDirection: "row"');
    expect(homeFn).toContain("seg.fg");
  });

  test("art segments cover the same block as homeArtLines (plain text, no ANSI)", () => {
    const noEsc = (s: string): boolean => !s.includes(String.fromCharCode(27));
    for (const w of [80, 40, 20]) {
      const segs = homeArtSegments(w);
      const lines = homeArtLines(w);
      expect(segs.length).toBe(lines.length);
      segs.forEach((chunks, i) => {
        const line = lines[i] ?? "";
        expect(chunks.map((c) => c.text).join("")).toBe(line === "" ? " " : line);
        for (const c of chunks) {
          expect(noEsc(c.text)).toBe(true);
          if (c.fg) expect(c.fg).toMatch(/^#[0-9A-F]{6}$/);
        }
      });
    }
  });
});
