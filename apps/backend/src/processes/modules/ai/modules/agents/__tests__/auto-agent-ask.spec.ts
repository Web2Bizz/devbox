/**
 * AutoAgent ask-route checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/agents/__tests__/auto-agent-ask.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: routing route='ask' (jev choice or heuristic) → direct
 * AskAgent.ask(question, userId, correlationId) with log
 * '[agents] auto route=ask direct', domain executors never called
 * (no decomposition/chain).
 */
import assert from "node:assert/strict";
import { AutoAgent } from "../auto.agent";
import { WorkflowsService } from "../../workflows/workflows.service";

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
      throw new Error(`${name} must not be called on the ask route`);
    },
  };
}

function makeAuto(
  route: { route: "ask"; provider: "jev" | "heuristic"; confidence?: number },
  entries: Array<LogEntry>,
  seen: { question?: string; userId?: string; correlationId?: string },
): AutoAgent {
  const jev = { classify: async () => route };
  const askAgent = {
    ask: async (question: string, userId: string, correlationId?: string) => {
      seen.question = question;
      seen.userId = userId;
      seen.correlationId = correlationId;
      return "direct-answer";
    },
  };
  return new AutoAgent(
    boom("backend") as never,
    boom("frontend") as never,
    boom("fullstack") as never,
    jev as never,
    askAgent as never,
    new WorkflowsService(fakeLogger(entries) as never),
    fakeLogger(entries) as never,
  );
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "jev choice ask → direct AskAgent call, no chain",
    run: async () => {
      const entries: Array<LogEntry> = [];
      const seen: { question?: string; userId?: string; correlationId?: string } = {};
      const auto = makeAuto({ route: "ask", provider: "jev", confidence: 0.9 }, entries, seen);
      const res = await auto.ask("объясни, что это такое", "u1", "cid-1");
      assert.equal(res, "direct-answer");
      assert.equal(seen.question, "объясни, что это такое");
      assert.equal(seen.userId, "u1");
      assert.equal(seen.correlationId, "cid-1");
      assert.ok(entries.some((e) => e.message === "[agents] auto route=ask direct"));
    },
  },
  {
    name: "heuristic ask → direct AskAgent call, no chain",
    run: async () => {
      const entries: Array<LogEntry> = [];
      const seen: { question?: string; userId?: string; correlationId?: string } = {};
      const auto = makeAuto({ route: "ask", provider: "heuristic" }, entries, seen);
      const res = await auto.ask("подскажи, как это работает", "u2", "cid-2");
      assert.equal(res, "direct-answer");
      assert.equal(seen.question, "подскажи, как это работает");
      assert.ok(entries.some((e) => e.message === "[agents] auto route=ask direct"));
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
    console.error(`${failed}/${checks.length} auto ask-route checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} auto ask-route checks failed`);
  }
  console.log(`${checks.length}/${checks.length} auto ask-route checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`auto ask-route checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
