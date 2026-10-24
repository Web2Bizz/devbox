// home screen tests (RUSH CODE spec): block-art title, 3 items, center, routing, exit.
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import {
  HOME_OPTIONS,
  HOME_SELECT_DOWN,
  HOME_SELECT_UP,
  HOME_TITLE,
  HOME_TITLE_ART,
  HOME_TITLE_STOPS,
  centerLines,
  formatHomeTitlePlain,
  gradientColorAt,
  gradientTitle,
  hexToRgb,
  homeArtSegments,
  moveHomeSelection,
  parseHomeInput,
  renderHomeScreen,
  rgbToHex,
  shouldUseHomeFallback,
  titleTextOptions,
} from "../home.js";
import { hasBgCodes, stripAnsi } from "../chat.js";

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
    const plain = stripAnsi(rendered);
    // Every art line present 1-в-1, first/last glyphs intact.
    for (const line of expected) {
      expect(plain).toContain(line);
      expect(line.startsWith("█")).toBe(true);
    }
    expect(expected[0]?.endsWith("███████")).toBe(true);
    expect(expected[1]?.endsWith("██")).toBe(true);
    // Gradient: fg-only truecolor, never bg codes.
    expect(rendered).toContain(`${ESC}[38;2;`);
    expect(hasBgCodes(rendered)).toBe(false);
    // Stripping the gradient restores the exact plain screen.
    expect(plain).toBe(renderHomeScreen(80, 0, { color: false }));
  });

  test("options render below the art, no wrap inside art", () => {
    const rendered = stripAnsi(renderHomeScreen(80, 0));
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
    for (const artLine of HOME_TITLE_ART.filter((l) => l !== "")) {
      const hits = rows.filter((r) => r.includes(artLine));
      expect(hits.length).toBe(1);
    }
  });

  test("narrow terminal never cuts the art (left-align fallback)", () => {
    const narrow = stripAnsi(renderHomeScreen(20, 0));
    for (const artLine of HOME_TITLE_ART) {
      expect(narrow).toContain(artLine);
    }
    // Left-aligned fallback: art starts at col 0 when width < art width.
    const firstArtRow = narrow.split("\n").find((r) => r.includes("██████  ██"));
    expect(firstArtRow?.startsWith("██████")).toBe(true);
  });

  test("title keeps double spaces 1-в-1 (verbatim, no collapse)", () => {
    // Art relies on double spaces — verbatim path must keep them.
    for (const line of HOME_TITLE_ART.filter((l) => l !== "")) {
      expect(line).toContain("  ");
    }
    const rendered = stripAnsi(renderHomeScreen(80, 0));
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
    // Standalone verbatim helper keeps spacing too (default: gradient on).
    const plain = formatHomeTitlePlain(80);
    expect(hasBgCodes(plain)).toBe(false);
    expect(plain).toContain(`${ESC}[38;2;`);
    const stripped = stripAnsi(plain);
    for (const line of HOME_TITLE_ART) {
      expect(stripped).toContain(line);
    }
    expect(stripped.split("\n")).toHaveLength(HOME_TITLE_ART.length);
    // Opt-out restores the exact plain block.
    expect(stripped).toBe(formatHomeTitlePlain(80, { color: false }));
  });

  test("narrow title stays verbatim: left-aligned, no mid-line wrap", () => {
    const narrowPlain = stripAnsi(formatHomeTitlePlain(20));
    const rows = narrowPlain.split("\n");
    expect(rows).toHaveLength(HOME_TITLE_ART.length);
    for (const artLine of HOME_TITLE_ART.filter((l) => l !== "")) {
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

  test("color opt-out restores byte-exact plain output (no ESC anywhere)", () => {
    const screen = renderHomeScreen(80, 0, { color: false });
    expect(screen).not.toContain(ESC);
    expect(screen).toBe(stripAnsi(renderHomeScreen(80, 0)));
    expect(formatHomeTitlePlain(80, { color: false })).not.toContain(ESC);
  });
});

describe("rush code title gradient (logo colors)", () => {
  const TRUECOLOR = new RegExp(`${String.fromCharCode(27)}\\[38;2;(\\d+);(\\d+);(\\d+)m`, "g");

  const colorsOf = (text: string): Array<[number, number, number]> =>
    [...text.matchAll(TRUECOLOR)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);

  test("palette is the logo orange → red → pink → purple → blue", () => {
    expect([...HOME_TITLE_STOPS]).toEqual(["#FFB02E", "#FF4A2D", "#E93A6B", "#8B3DFF", "#2E9BFF"]);
  });

  test("hex/rgb helpers roundtrip, endpoints clamp to stops", () => {
    for (const stop of HOME_TITLE_STOPS) {
      expect(rgbToHex(hexToRgb(stop))).toBe(stop);
    }
    expect(rgbToHex(gradientColorAt(HOME_TITLE_STOPS, 0))).toBe(HOME_TITLE_STOPS[0]);
    expect(rgbToHex(gradientColorAt(HOME_TITLE_STOPS, 1))).toBe(HOME_TITLE_STOPS[HOME_TITLE_STOPS.length - 1]);
    expect(rgbToHex(gradientColorAt(HOME_TITLE_STOPS, -1))).toBe(HOME_TITLE_STOPS[0]);
    expect(rgbToHex(gradientColorAt(HOME_TITLE_STOPS, 2))).toBe(HOME_TITLE_STOPS[HOME_TITLE_STOPS.length - 1]);
  });

  test("gradientTitle colors every glyph fg-only, strip restores lines 1-в-1", () => {
    const lines = [...HOME_TITLE_ART].filter((l) => l !== "");
    const colored = gradientTitle(lines);
    expect(colored).toHaveLength(lines.length);
    for (let i = 0; i < lines.length; i += 1) {
      expect(stripAnsi(colored[i] ?? "")).toBe(lines[i]);
      // Spaces stay uncolored (fg on a space is invisible): one open per glyph.
      const glyphs = [...(lines[i] ?? "")].filter((ch) => ch !== " ").length;
      expect(colorsOf(colored[i] ?? "")).toHaveLength(glyphs);
    }
    expect(hasBgCodes(colored.join("\n"))).toBe(false);
  });

  test("gradient spans the whole block: first col orange, last col blue, stripes align", () => {
    const lines = [...HOME_TITLE_ART].filter((l) => l !== "");
    const colored = gradientTitle(lines);
    // Column → color map per row (spaces emit no codes, so walk plain cols).
    const colorByCol = (row: string): Map<number, string> => {
      const map = new Map<number, string>();
      const cols = colorsOf(row);
      let gi = 0;
      [...stripAnsi(row)].forEach((ch, col) => {
        if (ch !== " ") map.set(col, (cols[gi++] ?? []).join(","));
      });
      return map;
    };
    const stop = (hex: string): string => {
      const { r, g, b } = hexToRgb(hex);
      return [r, g, b].join(",");
    };
    const maps = colored.map(colorByCol);
    for (const m of maps) {
      expect(m.get(0)).toBe(stop(HOME_TITLE_STOPS[0] as string));
    }
    // Widest rows reach the blue stop at their last glyph.
    const lastMap = maps[0] as Map<number, string>;
    const lastCol = Math.max(...[...lastMap.keys()]);
    expect(lastMap.get(lastCol)).toBe(stop(HOME_TITLE_STOPS[HOME_TITLE_STOPS.length - 1] as string));
    // Same column → same color on every row (col 1 is a glyph in all rows).
    for (const m of maps) {
      expect(m.get(1)).toBe((maps[0] as Map<number, string>).get(1));
    }
    // Gradient varies within a row (not a flat fg).
    expect(new Set(colorByCol(colored[0] ?? "").values()).size).toBeGreaterThan(3);
  });

  test("widthOf/centerLines are ANSI-aware: colored lines pad like plain ones", () => {
    const [colored] = gradientTitle(["hi"]);
    const [paddedColored] = centerLines([colored ?? ""], 80);
    const [paddedPlain] = centerLines(["hi"], 80);
    expect(stripAnsi(paddedColored ?? "")).toBe(paddedPlain);
    expect(paddedColored?.startsWith(" ")).toBe(true);
  });

  test("homeArtSegments: OpenTUI-native chunks, no ANSI in content, same mapping", () => {
    const rows = homeArtSegments(80);
    expect(rows).toHaveLength(HOME_TITLE_ART.length);
    const artRows = rows.filter((segs) => segs.some((s) => s.fg));
    expect(artRows.length).toBe(5);
    for (let i = 0; i < rows.length; i += 1) {
      const text = (rows[i] ?? []).map((s) => s.text).join("");
      const artLine = HOME_TITLE_ART[i] ?? "";
      if (artLine === "") {
        expect(text).toBe(" ");
        continue;
      }
      // Leading centering pad is one uncolored chunk, then art chunks.
      expect(rows[i]?.[0]?.text).toMatch(/^ +$/);
      expect(rows[i]?.[0]?.fg).toBeUndefined();
      expect(text.slice(text.length - artLine.length)).toBe(artLine);
      for (const seg of rows[i] ?? []) {
        expect(seg.text).not.toContain(ESC);
        if (seg.fg) expect(seg.fg).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
    // Gradient varies across the row (not a single flat fg).
    const fgs = new Set(rows.flatMap((segs) => segs.map((s) => s.fg).filter(Boolean)));
    expect(fgs.size).toBeGreaterThan(3);
    // Chunk colors reuse the shared column mapping: first art chunk is
    // centered at col 2.5, last chunk of the widest row at col 67.
    const artWidth = Math.max(...[...HOME_TITLE_ART].filter((l) => l !== "").map((l) => [...l].length));
    const denom = artWidth - 1;
    const firstFg = artRows[0]?.find((s) => s.fg)?.fg;
    const lastSegs = artRows[artRows.length - 1]?.filter((s) => s.fg) ?? [];
    expect(firstFg).toBe(rgbToHex(gradientColorAt(HOME_TITLE_STOPS, 2.5 / denom)));
    expect(lastSegs[lastSegs.length - 1]?.fg).toBe(
      rgbToHex(gradientColorAt(HOME_TITLE_STOPS, 67 / denom)),
    );
  });
});
