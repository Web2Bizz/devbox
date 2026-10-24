// tui React-contract tests (no renderer instantiated: neither @opentui/core
// native bindings nor the reconciler load — source + pure helpers only).
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeArtLines, homeOptionLine, homeArtSegments } from "../screens/home/index.js";
import { normalizePastedText, TUI_INPUT_MAX_LENGTH } from "../../core/utils/paste.js";
import { TUI_HISTORY_CAP, tuiStartupOrder } from "../../commands/session.js";

const UI_DIR = join(import.meta.dir, "..");
// Runners live in commands/ (commands/runners.ts + commands/session.ts):
// concat both so the contract checks below keep seeing all symbols.
const COMMANDS_TUI = [join(UI_DIR, "..", "commands", "runners.ts"), join(UI_DIR, "..", "commands", "session.ts")];
const TUI_SOURCE = COMMANDS_TUI.map((p) => readFileSync(p, "utf8")).join("\n");
// Split tree (screens/index.ts re-exports screens/*/index.tsx; store lives in shared/):
// explicit list so the contract checks below keep seeing every node/prop.
const TUI_APP_PARTS = [
  "shared/store.ts",
  "screens/home/HomeScreen.tsx",
  "screens/home/index.tsx",
  "screens/projects/ProjectsScreen.tsx",
  "screens/projects/DirInputScreen.tsx",
  "screens/projects/index.tsx",
  "screens/repl/ReplScreen.tsx",
  "screens/repl/index.tsx",
  "screens/error/ErrorScreen.tsx",
  "screens/error/index.tsx",
  "screens/index.ts",
];
const TUI_APP_SOURCE = TUI_APP_PARTS.map((rel) => readFileSync(join(UI_DIR, rel), "utf8")).join("\n");
const TUI_ALL = `${TUI_SOURCE}\n${TUI_APP_SOURCE}`;
// Home module lives in screens/home/ (index.tsx barrel + HomeScreen + 5 part files).
const HOME_PARTS = [
  "screens/home/index.tsx",
  "screens/home/HomeScreen.tsx",
  "screens/home/constants.ts",
  "screens/home/gradient.ts",
  "screens/home/layout.ts",
  "screens/home/screen.ts",
  "screens/home/nav.ts",
];
const HOME_SOURCE = HOME_PARTS.map((rel) => readFileSync(join(UI_DIR, rel), "utf8")).join("\n");

function expectTransparent(source: string): void {
  expect(source).not.toMatch(/backgroundColor|setBackgroundColor/);
  expect(source).not.toMatch(/\bbackground\b/i);
  expect(source).not.toMatch(/\bfill\b/i);
  expect(source).not.toMatch(/\bRect\b/);
  expect(source).not.toMatch(/[{,\s]bg\s*:/);
}

describe("tui transparency (terminal shows through)", () => {
  test("render code sets no backdrop: no bg props in commands/ or screens/", () => {
    expectTransparent(TUI_SOURCE);
    expectTransparent(TUI_APP_SOURCE);
  });

  test("chat history is full terminal width (100%, renderer → stdout.columns)", () => {
    expect(TUI_APP_SOURCE).toContain('width="100%"');
    expect(TUI_SOURCE).toContain("resolveTerminalWidth");
    expect(TUI_SOURCE).toContain("session.width");
    expect(TUI_ALL).not.toContain("BOX_WIDTH");
  });

  test("chat messages carry fg-only color (user cyan, agent green, no backdrop)", () => {
    expect(TUI_SOURCE).toContain("USER_FG");
    expect(TUI_SOURCE).toContain("AGENT_FG");
    expect(TUI_SOURCE).toContain("printUser");
    expect(TUI_SOURCE).toContain("printAgent");
    expect(TUI_SOURCE).toContain("fg: USER_FG");
    expect(TUI_SOURCE).toContain("fg: AGENT_FG");
  });

  test("rendering is declarative: createRoot + render, no imperative nodes", () => {
    expect(TUI_SOURCE).toContain("createRoot");
    expect(TUI_SOURCE).toContain(".render(");
    expect(TUI_SOURCE).toContain("createCliRenderer");
    expect(TUI_APP_SOURCE).toContain("<box");
    expect(TUI_APP_SOURCE).toContain("<text");
    expect(TUI_APP_SOURCE).toContain("<scrollbox");
    expect(TUI_APP_SOURCE).toContain("<input");
    expect(TUI_APP_SOURCE).toContain("stickyStart");
    expect(TUI_ALL).not.toContain("new BoxRenderable");
    expect(TUI_ALL).not.toContain("new TextRenderable");
    expect(TUI_ALL).not.toContain("new ScrollBoxRenderable");
    expect(TUI_ALL).not.toContain("new InputRenderable");
    expect(TUI_ALL).not.toContain("InputRenderableEvents");
    expect(TUI_ALL).not.toContain("keyInput");
  });

  test("input submits via onSubmit and stays focused at the bottom", () => {
    expect(TUI_APP_SOURCE).toContain("onSubmit");
    expect(TUI_APP_SOURCE).toContain("onInput");
    expect(TUI_APP_SOURCE).toContain("focused");
    expect(TUI_APP_SOURCE).toContain("space-between");
    expect(TUI_APP_SOURCE).toContain("stickyStart");
  });

  test("history is capped so the input never scrolls off", () => {
    expect(TUI_HISTORY_CAP).toBeGreaterThan(0);
    expect(TUI_SOURCE).toContain("TUI_HISTORY_CAP");
    expect(TUI_APP_SOURCE).toContain("createLineStore");
  });

  test("width follows the terminal (useTerminalDimensions + renderer fallback)", () => {
    expect(TUI_APP_SOURCE).toContain("useTerminalDimensions");
    expect(TUI_SOURCE).toContain("resolveTerminalWidth");
  });
});

describe("tui startup order (clear first, prompt last)", () => {
  test("order is clear → greeting → history → prompt", () => {
    expect(tuiStartupOrder()).toEqual(["clear", "greeting", "history", "prompt"]);
  });

  test("startup pushes a single greeting frame (no second hint box)", () => {
    expect(TUI_SOURCE).toContain("options.greeting");
    expect(TUI_SOURCE).not.toContain("options.hints");
  });
});

describe("tui gate (interactive is TUI-only)", () => {
  test("interactive is TUI-only: no RUSH_CODE_NO_TUI branching", () => {
    const interactiveSource = readFileSync(join(UI_DIR, "..", "commands", "interactive.ts"), "utf8");
    expect(interactiveSource).not.toContain("RUSH_CODE_NO_TUI");
  });
});

describe("tui paste (Ctrl+V / Shift+Ins / bracketed / multiline)", () => {
  const START = String.fromCharCode(27) + "[200~";
  const END = String.fromCharCode(27) + "[201~";

  test("paste-safe maxLength is raised and passed to <input>", () => {
    expect(TUI_INPUT_MAX_LENGTH).toBeGreaterThan(1000);
    expect(TUI_APP_SOURCE).toContain("maxLength");
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

  test("submit path normalizes + clears the controlled value (paste keeps flowing)", () => {
    expect(TUI_SOURCE).toContain("normalizePastedText");
    expect(TUI_SOURCE).toContain("onSubmitLine");
    expect(TUI_APP_SOURCE).toContain("onSubmit");
    expect(TUI_APP_SOURCE).toContain("onInput");
    expect(TUI_APP_SOURCE).toContain('setValue("")');
    expect(TUI_APP_SOURCE).toContain("focused");
  });
});

describe("tui title (verbatim block-art, no space collapse)", () => {
  test("title has a dedicated verbatim path (printTitle + titleTextOptions)", () => {
    expect(TUI_SOURCE).toContain("printTitle");
    expect(TUI_APP_SOURCE).toContain("titleTextOptions");
    expect(TUI_APP_SOURCE).toContain("wrapMode");
    expect(TUI_APP_SOURCE).toContain("truncate");
    // Title path never word-splits: chat wrap helper stays out of tui code.
    expect(TUI_ALL).not.toContain("wrapMessage");
    expect(TUI_ALL).not.toContain("printUserPlain");
    expect(TUI_ALL).not.toContain("printAgentPlain");
  });

  test("verbatim opts are wrapMode none + truncate false (right-clip, no mid wrap)", () => {
    expect(HOME_SOURCE).toContain('wrapMode: "none"');
    expect(HOME_SOURCE).toContain("truncate: false");
  });
});

describe("tui home (Главная без мигания: арт статичен, маркер инкрементален)", () => {
  test("startTuiHome exported; art drawn once via segments, options are separate nodes", () => {
    expect(TUI_SOURCE).toContain("startTuiHome");
    expect(HOME_SOURCE).toContain("HOME_TITLE_ART");
    expect(TUI_APP_SOURCE).toContain("titleTextOptions");
    expect(TUI_APP_SOURCE).toContain("homeArtSegments");
    expect(TUI_APP_SOURCE).toContain("HOME_OPTIONS");
    expect(TUI_APP_SOURCE).toContain("homeOptionLine(");
    expect(TUI_APP_SOURCE).toContain("homeSignatureLine");
    expect(TUI_APP_SOURCE).toContain("useKeyboard");
  });

  test("arrows repaint only the option rows (selected state moves, art untouched, no clear)", () => {
    expect(TUI_APP_SOURCE).toContain("moveHomeSelection");
    expect(TUI_APP_SOURCE).toContain("setSelected");
    // Home selector never clears the screen per keypress (old flicker path).
    const homeFn = TUI_APP_SOURCE.slice(TUI_APP_SOURCE.indexOf("HomeApp"));
    expect(homeFn).not.toContain("clearScreen");
    expect(homeFn).not.toContain("renderHomeScreen");
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

  test("home keeps transparency (fg-only, no backdrop)", () => {
    const homeFn = TUI_APP_SOURCE.slice(TUI_APP_SOURCE.indexOf("HomeApp"));
    expectTransparent(homeFn);
  });

  test("title gradient is React-native (row chunks with hex fg, no ANSI in content)", () => {
    const homeFn = TUI_APP_SOURCE.slice(TUI_APP_SOURCE.indexOf("HomeApp"));
    // <text> carries a single fg per node: one row <box> per art
    // line, plain chunks with interpolated hex fg (ANSI would render literally).
    expect(TUI_APP_SOURCE).toContain("homeArtSegments");
    expect(homeFn).toContain("homeArtSegments");
    expect(homeFn).toContain('flexDirection="row"');
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

describe("tui projects (пикер проекта: маркер ›, цифры, Esc → null)", () => {
  const PROJECTS_SOURCE = readFileSync(join(UI_DIR, "screens", "projects", "ProjectsScreen.tsx"), "utf8");

  test("rows reuse the home marker style (› follows selection, 1. name)", () => {
    expect(PROJECTS_SOURCE).toContain("›");
    expect(PROJECTS_SOURCE).toContain("useKeyboard");
    expect(PROJECTS_SOURCE).toContain("onSelect");
  });

  test("arrows move selection, Enter/digits confirm, Esc/q cancels", () => {
    expect(PROJECTS_SOURCE).toContain("setSelected");
    expect(PROJECTS_SOURCE).toContain('"return"');
    expect(PROJECTS_SOURCE).toContain("escape");
    expect(PROJECTS_SOURCE).toContain("onCancel");
  });

  test("presentational only: no fs, lists width 100%, transparent", () => {
    expect(PROJECTS_SOURCE).not.toContain("node:");
    expect(PROJECTS_SOURCE).not.toContain("listProjects");
    expect(PROJECTS_SOURCE).not.toContain("resolveProjectDir");
    expect(PROJECTS_SOURCE).toContain('width="100%"');
    expectTransparent(PROJECTS_SOURCE);
  });

  test("runners.ts resolves { index, name } on select, null on cancel", () => {
    expect(TUI_SOURCE).toContain("startTuiProjects");
    expect(TUI_SOURCE).toContain("ProjectsScreen");
    expect(TUI_SOURCE).toContain("finish(null)");
  });
});

describe("tui dir input (ввод директории: REPOS_ROOT, .. hint, Esc → null)", () => {
  const DIR_SOURCE = readFileSync(join(UI_DIR, "screens", "projects", "DirInputScreen.tsx"), "utf8");

  test("placeholder names REPOS_ROOT, hint keeps the .. ban", () => {
    expect(DIR_SOURCE).toContain("REPOS_ROOT");
    expect(DIR_SOURCE).toContain("запрещён");
  });

  test("single focused input with paste-safe maxLength, submit + Esc", () => {
    expect(DIR_SOURCE).toContain("maxLength");
    expect(DIR_SOURCE).toContain("TUI_INPUT_MAX_LENGTH");
    expect(DIR_SOURCE).toContain("focused");
    expect(DIR_SOURCE).toContain("onInput");
    expect(DIR_SOURCE).toContain("onSubmit");
    expect(DIR_SOURCE).toContain("escape");
    expect(DIR_SOURCE).toContain("onCancel");
  });

  test("presentational only: no fs, width 100%, transparent", () => {
    expect(DIR_SOURCE).not.toContain("node:");
    expect(DIR_SOURCE).not.toContain("resolveCustomDir");
    expect(DIR_SOURCE).toContain('width="100%"');
    expectTransparent(DIR_SOURCE);
  });

  test("runners.ts resolves the raw value on submit, null on cancel", () => {
    expect(TUI_SOURCE).toContain("startTuiDirInput");
    expect(TUI_SOURCE).toContain("DirInputScreen");
    expect(TUI_SOURCE).toContain("finish(null)");
  });
});

describe("tui react-only (native kinds, no core renderables)", () => {
  test("no imperative core nodes in TUI path (only createCliRenderer bootstrap)", () => {
    expect(TUI_ALL).not.toContain("new BoxRenderable");
    expect(TUI_ALL).not.toContain("new TextRenderable");
    expect(TUI_ALL).not.toContain("new ScrollBoxRenderable");
    expect(TUI_ALL).not.toContain("new InputRenderable");
    expect(TUI_ALL).not.toContain("InputRenderableEvents");
    expect(TUI_ALL).not.toContain("keyInput");
    expect(TUI_ALL).not.toContain("renderer.root");
    expect(TUI_ALL).not.toContain('from "@opentui/core"');
    expect(TUI_ALL).not.toContain("from '@opentui/core'");
    expect(TUI_SOURCE).toContain("createCliRenderer");
  });

  test("ReplScreen renders plain (no border anywhere)", () => {
    const repl = readFileSync(join(UI_DIR, "screens", "repl", "ReplScreen.tsx"), "utf8");
    expect(repl).toContain("<box");
    expect(repl).not.toContain("border");
  });

  test("store carries typed kind/variant", () => {
    const storeSource = readFileSync(join(UI_DIR, "shared", "store.ts"), "utf8");
    expect(storeSource).toMatch(/kind|variant/);
    expect(storeSource).toContain('"header"');
    expect(storeSource).toContain('"box"');
    expect(storeSource).toContain('"error"');
    expect(storeSource).toContain('"table"');
  });

  test("session exposes structural header/box/error/table", () => {
    expect(TUI_SOURCE).toContain("header: (");
    expect(TUI_SOURCE).toContain("box: (");
    expect(TUI_SOURCE).toContain("error: (");
    expect(TUI_SOURCE).toContain("table: (");
  });

  test("Spinner is self-sufficient: owns its timer, fg-only full width", () => {
    const spinnerSource = readFileSync(join(UI_DIR, "components", "Spinner.tsx"), "utf8");
    expect(spinnerSource).toContain("useEffect");
    expect(spinnerSource).toContain("setInterval");
    expect(spinnerSource).toContain("clearInterval");
    expect(spinnerSource).toContain("spinnerLine(");
    expect(spinnerSource).toContain('width="100%"');
    expect(spinnerSource).not.toContain("border");
  });

  test("session.spin delegates to <Spinner/> (no timers in runners)", () => {
    const runnersSource = readFileSync(join(UI_DIR, "..", "commands", "runners.ts"), "utf8");
    expect(runnersSource).toContain('kind: "spinner"');
    expect(runnersSource).not.toContain("setInterval");
  });
});

describe("no stdio в чате/открытии (только @opentui/react)", () => {
  const INTERACTIVE_SOURCE = readFileSync(join(import.meta.dir, "..", "..", "commands", "interactive.ts"), "utf8");
  const ERROR_SOURCE = readFileSync(join(UI_DIR, "screens", "error", "ErrorScreen.tsx"), "utf8");

  test("interactive.ts не импортирует node:readline", () => {
    expect(INTERACTIVE_SOURCE).not.toContain("node:readline");
    expect(INTERACTIVE_SOURCE).not.toContain("createInterface");
    expect(INTERACTIVE_SOURCE).not.toContain("questionLine");
    expect(INTERACTIVE_SOURCE).not.toContain("selectHomeFallback");
    expect(INTERACTIVE_SOURCE).not.toContain("startReadlineRepl");
  });

  test("интерактив идёт только через TUI-раннеры", () => {
    expect(INTERACTIVE_SOURCE).toContain("startTuiHome");
    expect(INTERACTIVE_SOURCE).toContain("startTuiProjects");
    expect(INTERACTIVE_SOURCE).toContain("startTuiDirInput");
    expect(INTERACTIVE_SOURCE).toContain("startTuiError");
    expect(TUI_SOURCE).toContain("startTuiError");
  });

  test("ErrorScreen: plain red, onClose + useKeyboard, fg-only, no border", () => {
    expect(ERROR_SOURCE).not.toContain("border");
    expect(ERROR_SOURCE).toContain('fg="red"');
    expect(ERROR_SOURCE).toContain("onClose");
    expect(ERROR_SOURCE).toContain("useKeyboard");
    expect(ERROR_SOURCE).toContain('width="100%"');
    expectTransparent(ERROR_SOURCE);
  });
});
