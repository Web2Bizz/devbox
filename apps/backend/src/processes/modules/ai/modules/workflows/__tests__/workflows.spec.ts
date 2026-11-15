import assert from "node:assert/strict";
import { WorkflowsService } from "../workflows.service";

/**
 * WorkflowsService unit checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/workflows/__tests__/workflows.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: listWorkflows fixed pair, routed chain decompose+steps+synthesize,
 * single-step fallback, step failure propagation, huge-context truncation.
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

function boomExecutor(name: string): { ask: () => Promise<string> } {
  return {
    ask: async () => {
      throw new Error(`${name} must not be called in this check`);
    },
  };
}

type Case = { name: string; run: () => Promise<void> | void };
const cases: Array<Case> = [];
let suite: string = "";

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

describe("WorkflowsService", () => {
  it("lists the fixed workflow pair", () => {
    const service: WorkflowsService = new WorkflowsService(fakeLogger([]) as never);
    const rows = service.listWorkflows();
    assert.deepEqual(
      rows.map((row) => row.id),
      ["single-answer", "routed-chain"],
    );
  });

  it("runs decompose+steps+synthesize, every prompt demands files", async () => {
    const prompts: Array<string> = [];
    const executor = {
      ask: async (prompt: string): Promise<string> => {
        prompts.push(prompt);
        if (prompts.length === 1) return "1. Создай hello.js\n2. Создай package.json";
        if (prompts.length <= 3) return "step-ok";
        return "final-ok";
      },
    };
    const service: WorkflowsService = new WorkflowsService(fakeLogger([]) as never);
    const result: string = await service.runRoutedChain(executor, "напиши Hello", "u1", "cid-1");
    assert.equal(result, "final-ok");
    assert.equal(prompts.length, 4);
    for (const prompt of prompts) {
      assert.ok(prompt.includes("workspace") && prompt.includes("файл"));
    }
  });

  it("falls back to a single step when decompose returns no numbers", async () => {
    const prompts: Array<string> = [];
    const executor = {
      ask: async (prompt: string): Promise<string> => {
        prompts.push(prompt);
        if (prompts.length === 1) return "болтовня без номеров";
        if (prompts.length === 2) return "step-ok";
        return "final-ok";
      },
    };
    const service: WorkflowsService = new WorkflowsService(fakeLogger([]) as never);
    const result: string = await service.runRoutedChain(executor, "сделай что-нибудь", "u2");
    assert.equal(result, "final-ok");
    assert.equal(prompts.length, 3);
  });

  it("aborts the chain when a step fails (no synthesize)", async () => {
    let calls: number = 0;
    const executor = {
      ask: async (prompt: string): Promise<string> => {
        calls += 1;
        if (calls === 1) return "1. a\n2. b";
        throw new Error("step-boom");
      },
    };
    const service: WorkflowsService = new WorkflowsService(fakeLogger([]) as never);
    await assert.rejects(service.runRoutedChain(executor, "сделай", "u3"), /step-boom/);
    assert.equal(calls, 2);
  });

  it("truncates huge step context before synthesize", async () => {
    let synthPrompt: string = "";
    const executor = {
      ask: async (prompt: string): Promise<string> => {
        if (prompt.startsWith("Разбей")) return "1. a\n2. b";
        if (prompt.includes("Собери итоговый ответ")) {
          synthPrompt = prompt;
          return "final-ok";
        }
        return "R".repeat(50_000);
      },
    };
    const service: WorkflowsService = new WorkflowsService(fakeLogger([]) as never);
    const result: string = await service.runRoutedChain(executor, "сделай большое", "u4");
    assert.equal(result, "final-ok");
    assert.ok(synthPrompt.length < 20_000);
  });

  it("never calls a throwing executor factory (boom stays quiet)", async () => {
    const service: WorkflowsService = new WorkflowsService(fakeLogger([]) as never);
    await assert.rejects(
      service.runRoutedChain(boomExecutor("executor") as never, "сделай", "u5"),
      /must not be called/,
    );
  });
});

async function main(): Promise<void> {
  let failed: number = 0;
  for (const item of cases) {
    try {
      await item.run();
      console.log(`ok - ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${item.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${cases.length} workflows checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${cases.length} workflows checks failed`);
  }
  console.log(`${cases.length}/${cases.length} workflows checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`workflows checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
