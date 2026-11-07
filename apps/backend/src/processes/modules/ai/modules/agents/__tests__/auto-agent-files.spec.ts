import assert from "node:assert/strict";
import { AutoAgent, AUTO_FILES_REQUIREMENT, UNCLEAR_REQUEST_MESSAGE, parseSteps } from "../auto.agent";
import { BACKEND_SYSTEM } from "../backend.agent";
import { FRONTEND_SYSTEM } from "../frontend.agent";
import { FULLSTACK_SYSTEM } from "../fullstack.agent";

/**
 * CARD-4 auto-prompt harden — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/agents/__tests__/auto-agent-files.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: parseSteps numbering/empty/cap, every domain system prompt demands
 * files in workspace, AutoAgent decompose/step/synthesize prompts demand
 * files, UNCLEAR_REQUEST_MESSAGE unchanged, ask route still direct,
 * parseSteps boundary/hostile/huge, single-step fallback, step/decompose
 * failure propagation, unclear isolation, unknown-route fallback, repeat
 * isolation, huge-context truncation.
 */

type LogEntry = { level: string; message: string };

function fakeLogger(entries: Array<LogEntry>): unknown {
  const record = (level: string) => (message: unknown): void => {
    entries.push({ level, message: String(message) });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    log: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
  };
}

function boom(name: string): { ask: () => Promise<string> } {
  return {
    ask: async () => {
      throw new Error(`${name} must not be called in this check`);
    },
  };
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "parseSteps keeps numbered lines, drops empties, caps at 5",
    run: async () => {
      assert.deepEqual(parseSteps("1. Создай hello.js\n2) Создай package.json\nболтовня"), [
        "Создай hello.js",
        "Создай package.json",
      ]);
      assert.deepEqual(parseSteps("только текст без шагов"), []);
      assert.deepEqual(
        parseSteps("1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g"),
        ["a", "b", "c", "d", "e"],
      );
    },
  },
  {
    name: "domain system prompts demand files in workspace",
    run: async () => {
      for (const system of [BACKEND_SYSTEM, FRONTEND_SYSTEM, FULLSTACK_SYSTEM]) {
        assert.ok(system.includes("файлы в workspace проекта"), `system must demand files: ${system}`);
        assert.ok(system.includes("без файлов запрещён"), `system must forbid text-only: ${system}`);
      }
    },
  },
  {
    name: "AUTO_FILES_REQUIREMENT is the shared file-result guard",
    run: async () => {
      assert.ok(AUTO_FILES_REQUIREMENT.includes("файлы в workspace проекта"));
      assert.ok(AUTO_FILES_REQUIREMENT.includes("без файлов запрещён"));
    },
  },
  {
    name: "decompose/step/synthesize prompts demand files",
    run: async () => {
      const prompts: Array<string> = [];
      const executor = {
        ask: async (prompt: string): Promise<string> => {
          prompts.push(prompt);
          if (prompts.length === 1) return "1. Создай hello.js\n2. Создай package.json";
          if (prompts.length <= 3) return "step-ok";
          return "final-ok";
        },
      };
      const jev = { classify: async () => ({ route: "backend", provider: "jev" }) };
      const auto = new AutoAgent(
        executor as never,
        boom("frontend") as never,
        boom("fullstack") as never,
        jev as never,
        boom("ask") as never,
        fakeLogger([]) as never,
      );
      const res = await auto.ask("напиши Hello World на NodeJS", "u1", "cid-files");
      assert.equal(res, "final-ok");
      assert.ok(prompts.length === 4, `expected decompose+2 steps+synthesize, got ${prompts.length}`);
      for (const prompt of prompts) {
        assert.ok(
          prompt.includes("workspace") && prompt.includes("файл"),
          `every chain prompt must demand files, got: ${prompt.slice(0, 120)}`,
        );
      }
    },
  },
  {
    name: "UNCLEAR_REQUEST_MESSAGE unchanged (no file demand, honest text)",
    run: async () => {
      assert.equal(
        UNCLEAR_REQUEST_MESSAGE,
        "Не понял запрос: непонятно, это backend, frontend или fullstack-задача. Уточни: что сделать, где (сервис/страница/оба) и что должно получиться.",
      );
    },
  },
  {
    name: "ask route still answers direct without decomposition",
    run: async () => {
      const seen: { question?: string } = {};
      const jev = { classify: async () => ({ route: "ask", provider: "jev", confidence: 0.9 }) };
      const askAgent = {
        ask: async (question: string): Promise<string> => {
          seen.question = question;
          return "direct-answer";
        },
      };
      const auto = new AutoAgent(
        boom("backend") as never,
        boom("frontend") as never,
        boom("fullstack") as never,
        jev as never,
        askAgent as never,
        fakeLogger([]) as never,
      );
      const res = await auto.ask("объясни что такое Hello World", "u2", "cid-ask");
      assert.equal(res, "direct-answer");
      assert.equal(seen.question, "объясни что такое Hello World");
    },
  },
  {
    name: "parseSteps boundary: empties/whitespace/dash-noise dropped",
    run: async () => {
      assert.deepEqual(parseSteps(""), []);
      assert.deepEqual(parseSteps("   \n  \n"), []);
      assert.deepEqual(parseSteps("1.   \n2.    \n- just dash\n* star\n1: colon-no"), []);
      assert.deepEqual(parseSteps("  1.  spaced  \n\t2)\ttabbed"), ["spaced", "tabbed"]);
      assert.deepEqual(parseSteps("0. zero-index kept"), ["zero-index kept"]);
    },
  },
  {
    name: "parseSteps hostile: null/undefined/number throw (no silent [])",
    run: async () => {
      assert.throws(() => parseSteps(null as unknown as string));
      assert.throws(() => parseSteps(undefined as unknown as string));
      assert.throws(() => parseSteps(123 as unknown as string));
    },
  },
  {
    name: "parseSteps huge: 10k lines still caps at 5",
    run: async () => {
      const big = Array.from({ length: 10_000 }, (_, i) => `${i + 1}. step-${i + 1}`).join("\n");
      const steps = parseSteps(big);
      assert.equal(steps.length, 5);
      assert.deepEqual(steps, ["step-1", "step-2", "step-3", "step-4", "step-5"]);
    },
  },
  {
    name: "single-step fallback still demands files (decompose+step+synthesize)",
    run: async () => {
      const prompts: Array<string> = [];
      const executor = {
        ask: async (prompt: string): Promise<string> => {
          prompts.push(prompt);
          if (prompts.length === 1) return "болтовня без номеров";
          if (prompts.length === 2) return "step-ok";
          return "final-ok";
        },
      };
      const jev = { classify: async () => ({ route: "backend", provider: "jev" }) };
      const auto = new AutoAgent(
        executor as never,
        boom("frontend") as never,
        boom("fullstack") as never,
        jev as never,
        boom("ask") as never,
        fakeLogger([]) as never,
      );
      const res = await auto.ask("сделай что-нибудь", "u3", "cid-fallback");
      assert.equal(res, "final-ok");
      assert.equal(prompts.length, 3);
      for (const prompt of prompts) {
        assert.ok(prompt.includes("workspace") && prompt.includes("файл"));
      }
    },
  },
  {
    name: "step failure aborts chain (no synthesize, error propagates)",
    run: async () => {
      const prompts: Array<string> = [];
      const executor = {
        ask: async (prompt: string): Promise<string> => {
          prompts.push(prompt);
          if (prompts.length === 1) return "1. a\n2. b";
          throw new Error("step-boom");
        },
      };
      const jev = { classify: async () => ({ route: "backend", provider: "jev" }) };
      const auto = new AutoAgent(
        executor as never,
        boom("frontend") as never,
        boom("fullstack") as never,
        jev as never,
        boom("ask") as never,
        fakeLogger([]) as never,
      );
      await assert.rejects(auto.ask("сделай", "u4", "cid-step-fail"), /step-boom/);
      assert.equal(prompts.length, 2);
    },
  },
  {
    name: "decompose failure propagates (no steps, no synthesize)",
    run: async () => {
      let calls = 0;
      const executor = {
        ask: async (): Promise<string> => {
          calls += 1;
          throw new Error("decompose-boom");
        },
      };
      const jev = { classify: async () => ({ route: "frontend", provider: "jev" }) };
      const auto = new AutoAgent(
        boom("backend") as never,
        executor as never,
        boom("fullstack") as never,
        jev as never,
        boom("ask") as never,
        fakeLogger([]) as never,
      );
      await assert.rejects(auto.ask("сделай фронт", "u5", "cid-decompose-fail"), /decompose-boom/);
      assert.equal(calls, 1);
    },
  },
  {
    name: "unclear route answers honest text without touching executors",
    run: async () => {
      let calls = 0;
      const executor = {
        ask: async (): Promise<string> => {
          calls += 1;
          return "must-not-run";
        },
      };
      const jev = { classify: async () => ({ route: "unclear", provider: "jev" }) };
      const auto = new AutoAgent(
        executor as never,
        executor as never,
        executor as never,
        jev as never,
        boom("ask") as never,
        fakeLogger([]) as never,
      );
      const res = await auto.ask("абырвалг", "u6", "cid-unclear");
      assert.equal(res, UNCLEAR_REQUEST_MESSAGE);
      assert.equal(calls, 0);
    },
  },
  {
    name: "hostile unknown route defaults to backend executor",
    run: async () => {
      const prompts: Array<string> = [];
      const backend = {
        ask: async (prompt: string): Promise<string> => {
          prompts.push(prompt);
          if (prompts.length === 1) return "1. a";
          if (prompts.length === 2) return "step-ok";
          return "final-ok";
        },
      };
      const jev = { classify: async () => ({ route: "weird", provider: "jev" }) };
      const auto = new AutoAgent(
        backend as never,
        boom("frontend") as never,
        boom("fullstack") as never,
        jev as never,
        boom("ask") as never,
        fakeLogger([]) as never,
      );
      const res = await auto.ask("сделай", "u7", "cid-weird");
      assert.equal(res, "final-ok");
      assert.ok(prompts.length === 3);
    },
  },
  {
    name: "repeat identical ask is isolated (no shared chain state)",
    run: async () => {
      const prompts: Array<string> = [];
      const executor = {
        ask: async (prompt: string): Promise<string> => {
          prompts.push(prompt);
          if (prompt.startsWith("Разбей")) return "1. Создай hello.js";
          if (prompts.filter((p) => p.startsWith("Исходная задача")).length === 1) return "step-ok";
          return "final-ok";
        },
      };
      const jev = { classify: async () => ({ route: "backend", provider: "jev" }) };
      const auto = new AutoAgent(
        executor as never,
        boom("frontend") as never,
        boom("fullstack") as never,
        jev as never,
        boom("ask") as never,
        fakeLogger([]) as never,
      );
      const first = await auto.ask("напиши Hello World на NodeJS", "u8", "cid-r1");
      const second = await auto.ask("напиши Hello World на NodeJS", "u8", "cid-r2");
      assert.equal(first, "final-ok");
      assert.equal(second, "final-ok");
      assert.equal(prompts.length, 6);
    },
  },
  {
    name: "huge step context is truncated (synthesize stays bounded)",
    run: async () => {
      let synthPrompt = "";
      const executor = {
        ask: async (prompt: string): Promise<string> => {
          if (prompt.startsWith("Разбей")) return "1. a\n2. b";
          if (prompt.startsWith("Собери") || prompt.includes("Собери итоговый")) {
            synthPrompt = prompt;
            return "final-ok";
          }
          return "R".repeat(50_000);
        },
      };
      const jev = { classify: async () => ({ route: "backend", provider: "jev" }) };
      const auto = new AutoAgent(
        executor as never,
        boom("frontend") as never,
        boom("fullstack") as never,
        jev as never,
        boom("ask") as never,
        fakeLogger([]) as never,
      );
      const res = await auto.ask("сделай большое", "u9", "cid-huge-ctx");
      assert.equal(res, "final-ok");
      assert.ok(synthPrompt.includes("workspace") && synthPrompt.includes("файл"));
      assert.ok(synthPrompt.length < 20_000, `synthesize must truncate context, got ${synthPrompt.length}`);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} auto files checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} auto files checks failed`);
  }
  console.log(`${checks.length}/${checks.length} auto files checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`auto files checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
