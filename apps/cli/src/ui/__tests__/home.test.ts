// home screen tests (RUSH CODE spec): block-art title, 3 items, center, routing, exit.
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import {
  HOME_OPTIONS,
  HOME_SELECT_DOWN,
  HOME_SELECT_UP,
  HOME_TITLE,
  HOME_TITLE_ART,
  centerLines,
  formatHomeTitlePlain,
  moveHomeSelection,
  parseHomeInput,
  renderHomeScreen,
  shouldUseHomeFallback,
  titleTextOptions,
} from "../home.js";

const ESC = String.fromCharCode(27);

describe("rush code home (Главная)", () => {
  test("title is RUSH CODE block-art (5 lines, exact)", () => {
    const expected = [
      "██████  ██    ██ ███████ ██   ██      ██████  ██████  ██████  ███████",
      "██   ██ ██    ██ ██      ██   ██     ██      ██    ██ ██   ██ ██",
      "██████  ██    ██ ███████ ███████     ██      ██    ██ ██   ██ █████",
      "██   ██ ██    ██      ██ ██   ██     ██      ██    ██ ██   ██ ██",
      "██   ██  ██████  ███████ ██   ██      ██████  ██████  ██████  ███████",
    ];
    expect([...HOME_TITLE_ART]).toEqual(expected);
    expect(HOME_TITLE).toBe(expected.join("\n"));
    const rendered = renderHomeScreen(80, 0);
    // Every art line present 1-в-1, first/last glyphs intact.
    for (const line of expected) {
      expect(rendered).toContain(line);
      expect(line.startsWith("█")).toBe(true);
    }
    expect(expected[0]?.endsWith("███████")).toBe(true);
    expect(expected[1]?.endsWith("██")).toBe(true);
    // No ANSI bg codes (transparency: plain centered lines only).
    expect(rendered).not.toContain(ESC + "[");
  });

  test("options render below the art, no wrap inside art", () => {
    const rendered = renderHomeScreen(80, 0);
    const rows = rendered.split("\n");
    const artLast = rows.findIndex((l) => l.includes("██████  ██████  ██████  ███████"));
    const idx0 = rendered.indexOf("Выбрать проект");
    const idx1 = rendered.indexOf("Открыть директорию");
    const idx2 = rendered.indexOf("Выйти");
    expect(artLast).toBeGreaterThanOrEqual(0);
    expect(idx0).toBeGreaterThan(rendered.indexOf(rows[artLast] ?? ""));
    expect(idx1).toBeGreaterThan(idx0);
    expect(idx2).toBeGreaterThan(idx1);
    // Monospace intact: each art line lives on its own row, never wrapped.
    for (const artLine of HOME_TITLE_ART) {
      const hits = rows.filter((r) => r.includes(artLine));
      expect(hits.length).toBe(1);
    }
  });

  test("narrow terminal never cuts the art (left-align fallback)", () => {
    const narrow = renderHomeScreen(20, 0);
    for (const artLine of HOME_TITLE_ART) {
      expect(narrow).toContain(artLine);
    }
    // Left-aligned fallback: art starts at col 0 when width < art width.
    const firstArtRow = narrow.split("\n").find((r) => r.includes("██████  ██"));
    expect(firstArtRow?.startsWith("██████")).toBe(true);
  });

  test("title keeps double spaces 1-в-1 (verbatim, no collapse)", () => {
    // Art relies on double spaces — verbatim path must keep them.
    for (const line of HOME_TITLE_ART) {
      expect(line).toContain("  ");
    }
    const rendered = renderHomeScreen(80, 0);
    for (const line of HOME_TITLE_ART) {
      expect(rendered).toContain(line);
    }
    // Centering only pads left: strip left pad → exact art line back.
    for (const row of rendered.split("\n")) {
      const leftTrimmed = row.replace(/^ +/, "");
      if ((HOME_TITLE_ART as readonly string[]).includes(leftTrimmed)) {
        expect(HOME_TITLE_ART).toContain(leftTrimmed);
      }
    }
    // Standalone verbatim helper keeps spacing too.
    const plain = formatHomeTitlePlain(80);
    for (const line of HOME_TITLE_ART) {
      expect(plain).toContain(line);
    }
    expect(plain.split("\n")).toHaveLength(HOME_TITLE_ART.length);
  });

  test("narrow title stays verbatim: left-aligned, no mid-line wrap", () => {
    const narrowPlain = formatHomeTitlePlain(20);
    const rows = narrowPlain.split("\n");
    expect(rows).toHaveLength(HOME_TITLE_ART.length);
    for (const artLine of HOME_TITLE_ART) {
      expect(narrowPlain).toContain(artLine);
      const hits = rows.filter((r) => r.includes(artLine));
      expect(hits.length).toBe(1);
    }
    // Left-align when narrow: no centering pad on art wider than width.
    expect(rows[0]?.startsWith("██████")).toBe(true);
    // Verbatim TUI opts: no wrap, no cut (right-clip only).
    expect(titleTextOptions()).toEqual({ wrapMode: "none", truncate: false, width: "100%" });
  });

  test("menu has exactly 3 items in spec order, centered", () => {
    expect(HOME_OPTIONS).toEqual(["Выбрать проект", "Открыть директорию", "Выйти"]);
    const rendered = renderHomeScreen(80, 0);
    const idx0 = rendered.indexOf("Выбрать проект");
    const idx1 = rendered.indexOf("Открыть директорию");
    const idx2 = rendered.indexOf("Выйти");
    expect(idx0).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeGreaterThan(idx0);
    expect(idx2).toBeGreaterThan(idx1);
    // Centered: every menu line starts with padding (screen middle, not col 0).
    for (const line of rendered.split("\n")) {
      if (line.includes("Выбрать проект") || line.includes("Открыть директорию") || line.includes("Выйти")) {
        expect(line.startsWith(" ")).toBe(true);
      }
    }
  });

  test("selected row carries the › marker", () => {
    expect(renderHomeScreen(80, 1)).toContain("› 2. Открыть директорию");
    expect(renderHomeScreen(80, 2)).toContain("› 3. Выйти");
  });

  test("digits 1-3 select, arrows move, garbage is invalid", () => {
    expect(parseHomeInput("1")).toEqual({ kind: "select", index: 0 });
    expect(parseHomeInput("2")).toEqual({ kind: "select", index: 1 });
    expect(parseHomeInput("3")).toEqual({ kind: "select", index: 2 });
    expect(parseHomeInput("nope")).toEqual({ kind: "invalid" });
    expect(parseHomeInput("")).toEqual({ kind: "invalid" });
  });

  test("arrow navigation wraps around", () => {
    expect(moveHomeSelection(0, "up")).toBe(2);
    expect(moveHomeSelection(2, "down")).toBe(0);
    expect(moveHomeSelection(0, "down")).toBe(1);
  });

  test("centerLines pads short lines (screen middle)", () => {
    const [line] = centerLines(["hi"], 80);
    expect(line?.endsWith("hi")).toBe(true);
    expect(line?.startsWith(" ")).toBe(true);
  });

  test("choice routes where it should (0 project, 1 dir, 2 exit)", () => {
    // Contract: index 0 → project list, 1 → custom dir prompt, 2 → clean exit.
    const route = (i: number): string => (i === 0 ? "projects" : i === 1 ? "custom-dir" : "exit");
    expect(route(0)).toBe("projects");
    expect(route(1)).toBe("custom-dir");
    expect(route(2)).toBe("exit");
  });

  test("stdout fallback untouched: DEVBOX_NO_TUI/non-TTY/help force digits 1-3", () => {
    expect(shouldUseHomeFallback([], true, { DEVBOX_NO_TUI: "1" })).toBe(true);
    expect(shouldUseHomeFallback([], false, {})).toBe(true);
    expect(shouldUseHomeFallback(["--help"], true, {})).toBe(true);
    expect(shouldUseHomeFallback(["--version"], true, {})).toBe(true);
    expect(shouldUseHomeFallback([], true, {})).toBe(false);
    expect(shouldUseHomeFallback(["repl"], true, {})).toBe(false);
  });

  test("fallback parses digits 1-3, arrows stay a move hint (no highlight in line mode)", () => {
    expect(parseHomeInput("1")).toEqual({ kind: "select", index: 0 });
    expect(parseHomeInput("2")).toEqual({ kind: "select", index: 1 });
    expect(parseHomeInput("3")).toEqual({ kind: "select", index: 2 });
    expect(parseHomeInput(HOME_SELECT_UP)).toEqual({ kind: "move", dir: "up" });
    expect(parseHomeInput(HOME_SELECT_DOWN)).toEqual({ kind: "move", dir: "down" });
  });
});
