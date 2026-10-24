// plain-text snapshot (no frames, no width-80): headerText/errorText/tableText/greetingLines.
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import { errorText, greetingLines, headerText, statusLine, tableText } from "../shared/plain.js";
import { spinnerFrame, SPINNER_FRAMES } from "../../core/utils/frames.js";
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
import { extractRefs, scrubSecrets } from "../../core/queries/refs/resolve.js";
import { isAllowedAgent, listAgents } from "../../agents/allowlist.js";
import { runAgent } from "../../agents/runner.js";

describe("plain snapshot (no frames)", () => {
  test("headerText returns title as-is (no ══ rule)", () => {
    expect(headerText("title")).toBe("title");
    expect(headerText("title")).not.toContain("═");
    expect(headerText("title")).not.toContain("┌");
  });

  test("errorText keeps ✗ and → hint (multiline)", () => {
    const rendered = errorText("boom", "fix it\nsecond line");
    expect(rendered).toContain("✗ boom");
    expect(rendered).toContain("→ fix it");
    expect(rendered).toContain("→ second line");
    expect(rendered).not.toContain("┌");
    expect(rendered).not.toContain("┘");
    expect(rendered).not.toContain("│");
    expect(rendered).not.toContain("╔");
  });

  test("tableText pads with two spaces, no borders; greetingLines keeps ◆", () => {
    const rendered = tableText(["agent", "desc"], [["ask", "readonly"]]);
    expect(rendered).toContain("agent");
    expect(rendered).toContain("ask");
    expect(rendered).not.toContain("│");
    expect(rendered).not.toContain("┌");
    expect(rendered).not.toContain("┘");
    expect(rendered).not.toContain("─");
    const greet = greetingLines("0.1.0").join("\n");
    expect(greet).toContain("◆ DEVBOX CLI v0.1.0");
    expect(greet).toContain("prompt >");
    expect(greet).toContain("@file");
    expect(greet).toContain("/agent");
    expect(greet).toContain("/help");
    expect(greet).toContain("/exit");
    expect(greet).not.toContain("╔");
    expect(greet).not.toContain("╚");
    expect(greet).not.toContain("┌");
    expect(greet).not.toContain("║");
  });

  test("statusLine markers stay (✓/✗/⚠/●, not a frame)", () => {
    expect(statusLine("ok", "hi")).toBe("✓ hi");
    expect(statusLine("err", "hi")).toBe("✗ hi");
    expect(statusLine("warn", "hi")).toBe("⚠ hi");
    expect(statusLine("run", "hi")).toBe("● hi");
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

  test("startup order: clear first, then single greeting block, prompt last", () => {
    // Mirrors cli.ts startRepl: clear → single greeting block → prompt.
    const writes: string[] = [];
    writes.push(CLEAR_SEQUENCE);
    writes.push(greetingLines("0.1.0").join("\n"));
    writes.push(PROMPT_LABEL);
    expect(writes[0]).toBe(CLEAR_SEQUENCE);
    expect(writes[1]).toContain("◆ DEVBOX CLI v0.1.0");
    expect(writes[1]).toContain("prompt >");
    expect(writes[1]).toContain("@file");
    expect(writes[1]).toContain("/agent");
    expect(writes[1]).toContain("/help");
    expect(writes[1]).toContain("/exit");
    // Plain block: no frame chars at all.
    const startup = writes.join("\n");
    expect(startup).not.toContain("╔");
    expect(startup).not.toContain("╚");
    expect(startup).not.toContain("┌");
    expect(startup).not.toContain("┘");
    expect(startup).not.toContain("│");
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

  test("startup hint helper stays plain lines for /help (not rendered at start)", () => {
    const lines = startupHintLines();
    expect(lines.join("\n")).toContain("type /help");
    expect(lines.join("\n")).toContain("refs:");
    expect(PROMPT_LABEL).toBe("prompt > ");
  });
});

describe("chat messages (plain full-width, no boxes)", () => {
  test("cli chat paths emit plain user/agent lines (greetingLines + errorText stay plain)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const cliDir = join(here, "..", "..");
    // Decomposed tree (cli.ts is a facade over commands/*.ts): concat all parts.
    const cliParts = [
      "cli.ts",
      ...readdirSync(join(cliDir, "commands"))
        .filter((f: string) => f.endsWith(".ts") && f !== "index.ts")
        .sort()
        .map((f: string) => join("commands", f)),
    ];
    const cliSource = cliParts.map((rel) => readFileSync(join(cliDir, rel), "utf8")).join("\n");
    // Chat replies go through sink.user/sink.agent (plain, fg-only).
    expect(cliSource).toContain("sink.user(");
    expect(cliSource).toContain("sink.agent(");
    // Greeting + errors are plain helpers.
    expect(cliSource).toContain("greetingLines(");
    expect(cliSource).toContain("errorText(");
  });
});
