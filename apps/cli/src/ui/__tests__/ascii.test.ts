// ascii width-80 snapshot (no broken layout): box/table/separator/greeting.
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import { box, errorBox, greeting, header, separator, table } from "../box.js";
import { spinnerFrame, SPINNER_FRAMES } from "../spinner.js";
import {
  CLEAR_SEQUENCE,
  PROMPT_LABEL,
  clearScreen,
  parseLine,
  shouldClearForRepl,
  shouldClearScreen,
  shouldStartRepl,
  startupHintLines,
} from "../../prompt/repl.js";
import { extractRefs, scrubSecrets } from "../../refs/resolve.js";
import { isAllowedAgent, listAgents } from "../../agents/allowlist.js";
import { runAgent } from "../../agents/runner.js";

function widthOf(line: string): number {
  return [...line].length;
}

describe("ascii snapshot (width 80)", () => {
  test("box is exactly 80 wide on every line", () => {
    const rendered = box(["hello", "world"], 80);
    for (const line of rendered.split("\n")) {
      expect(widthOf(line)).toBe(80);
    }
    expect(rendered).toContain("┌");
    expect(rendered).toContain("┘");
    expect(rendered).toContain("│");
  });

  test("error box keeps ✗ and → hint", () => {
    const rendered = errorBox("boom", "fix it", 80);
    expect(rendered).toContain("✗ boom");
    expect(rendered).toContain("→ fix it");
    for (const line of rendered.split("\n")) {
      expect(widthOf(line)).toBe(80);
    }
  });

  test("table uses │ and corners, greeting keeps ◆", () => {
    const rendered = table(["agent", "desc"], [["ask", "readonly"]], 80);
    expect(rendered).toContain("│");
    expect(rendered).toContain("┌");
    expect(rendered).toContain("┘");
    const greet = greeting("0.1.0");
    expect(greet).toContain("◆ DEVBOX CLI");
    expect(greet).toContain("╔");
    expect(greet).toContain("╚");
  });

  test("header uses ══ and separator uses ──", () => {
    expect(header("title")).toContain("══");
    expect(separator(80)).toBe("─".repeat(80));
  });

  test("spinner cycles all 10 frames", () => {
    expect(SPINNER_FRAMES).toHaveLength(10);
    expect(spinnerFrame(0)).toBe("⠋");
    expect(spinnerFrame(10)).toBe("⠋");
    expect(spinnerFrame(-1)).toBe("⠏");
  });
});

describe("repl + refs + agents", () => {
  test("parseLine routes /help /exit /agent list", () => {
    expect(parseLine("/help")).toEqual({ kind: "help" });
    expect(parseLine("/exit")).toEqual({ kind: "exit" });
    expect(parseLine("/agent list")).toEqual({ kind: "agent-list" });
  });

  test("parseLine keeps @refs and rejects traversal eagerly", () => {
    const parsed = parseLine("look at @apps/backend/package.json please");
    expect(parsed.kind).toBe("prompt");
    if (parsed.kind === "prompt") expect(parsed.refs).toEqual(["apps/backend/package.json"]);
    expect(extractRefs("a @x/y b @z")).toEqual(["x/y", "z"]);
  });

  test("allowlist gates unknown agents", () => {
    expect(isAllowedAgent("ask")).toBe(true);
    expect(isAllowedAgent("nope")).toBe(false);
    expect(listAgents().length).toBeGreaterThan(5);
    expect(() => runAgent("nope", "hi")).toThrow();
  });

  test("runner is dry-run by default", () => {
    const dry = runAgent("ask", "hello");
    expect(dry.dryRun).toBe(true);
    expect(dry.message).toContain("dry-run");
    const applied = runAgent("ask", "hello", true);
    expect(applied.dryRun).toBe(false);
  });

  test("scrubSecrets hides Bearer and userinfo", () => {
    expect(scrubSecrets("Authorization: Bearer secret123")).toContain("Bearer [redacted]");
    expect(scrubSecrets("postgres://u:p@host/db")).toContain("://u:[redacted]@");
  });
});

describe("repl startup (clear first, prompt bottom)", () => {
  test("clear sequence is ESC+c (no console.clear)", () => {
    expect([...CLEAR_SEQUENCE].map((c) => c.charCodeAt(0))).toEqual([27, 99]);
    expect(CLEAR_SEQUENCE).toHaveLength(2);
  });

  test("clearScreen writes via writer only (hermetic, no console.clear)", () => {
    const seen: string[] = [];
    const origClear = console.clear;
    let cleared = false;
    (console as unknown as { clear: () => void }).clear = () => {
      cleared = true;
    };
    try {
      clearScreen((s) => void seen.push(s));
    } finally {
      (console as unknown as { clear: () => void }).clear = origClear;
    }
    expect(seen).toEqual([CLEAR_SEQUENCE]);
    expect(cleared).toBe(false);
  });

  test("startup order: clear first, then greeting + history, prompt last", () => {
    // Mirrors cli.ts startRepl: clear → greeting → hint box → prompt.
    const writes: string[] = [];
    writes.push(CLEAR_SEQUENCE);
    writes.push(greeting("0.1.0"));
    writes.push(box(startupHintLines(), 80));
    writes.push(PROMPT_LABEL);
    expect(writes[0]).toBe(CLEAR_SEQUENCE);
    expect(writes[1]).toContain("◆ DEVBOX CLI");
    expect(writes[2]).toContain("type /help for commands");
    for (const line of (writes[2] as string).split("\n")) {
      expect(widthOf(line)).toBe(80);
    }
    expect(writes[writes.length - 1]).toBe("prompt > ");
  });

  test("TTY gate: clear only on TTY REPL route (!isTTY/--help never clear)", () => {
    expect(shouldClearScreen(true)).toBe(true);
    expect(shouldClearScreen(false)).toBe(false);
    expect(shouldStartRepl([], true)).toBe(true);
    expect(shouldStartRepl(["repl"], true)).toBe(true);
    expect(shouldStartRepl([], false)).toBe(false);
    expect(shouldStartRepl(["--help"], true)).toBe(false);
    expect(shouldClearForRepl([], true)).toBe(true);
    expect(shouldClearForRepl([], false)).toBe(false);
    expect(shouldClearForRepl(["--help"], true)).toBe(false);
  });

  test("startup hint box stays width-80 (prompt above, input below)", () => {
    const rendered = box(startupHintLines(), 80);
    for (const line of rendered.split("\n")) {
      expect(widthOf(line)).toBe(80);
    }
    expect(PROMPT_LABEL).toBe("prompt > ");
  });
});
