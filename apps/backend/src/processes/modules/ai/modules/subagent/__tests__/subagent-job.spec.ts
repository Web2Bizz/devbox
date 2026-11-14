import assert from "node:assert/strict";
import { SubagentJobService } from "../subagent-job.service";
import type { SubagentAgentFacade } from "../subagent.types";

/**
 * SubagentJobService unit checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/subagent/__tests__/subagent-job.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: run resolves + asks through the facade (settlement shape, callID
 * preserved vs generated), failure becomes an error-result (never throws),
 * listExecutors exposes only subagent-mode rows.
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

type FakeAgent = { id: string; name: string; description: string; hidden: boolean; mode: string };

function makeFacade(overrides: {
  ask?: (agentId: string, prompt: string, userId: string, correlationId?: string) => Promise<string>;
  resolve?: (agentId?: string) => FakeAgent;
  listAll?: () => Array<FakeAgent>;
} = {}): SubagentAgentFacade {
  const ask =
    overrides.ask ?? (async (agentId: string, prompt: string) => `${agentId}:${prompt}`);
  const resolve =
    overrides.resolve ??
    ((agentId?: string): FakeAgent => ({
      id: agentId ?? "ask",
      name: agentId ?? "ask",
      description: `${agentId ?? "ask"} executor`,
      hidden: false,
      mode: "primary",
    }));
  const listAll =
    overrides.listAll ??
    ((): Array<FakeAgent> => [
      { id: "ask", name: "Ask", description: "ask", hidden: false, mode: "primary" },
      { id: "backend", name: "Backend", description: "backend", hidden: true, mode: "subagent" },
    ]);
  return {
    askQuestion: ask,
    resolve: resolve as SubagentAgentFacade["resolve"],
    listAll: listAll as SubagentAgentFacade["listAll"],
  };
}

function makeService(facade: SubagentAgentFacade): SubagentJobService {
  const service: SubagentJobService = Object.create(SubagentJobService.prototype);
  (service as unknown as Record<string, unknown>).facade = facade;
  (service as unknown as Record<string, unknown>).logger = fakeLogger([]);
  return service;
}

type Case = { name: string; run: () => Promise<void> };
const cases: Array<Case> = [];
let suite: string = "";

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = "";
}

function it(name: string, run: () => Promise<void>): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

describe("SubagentJobService", () => {
  it("settles success with the preserved callID", async () => {
    const seen: { agentId?: string; prompt?: string; userId?: string } = {};
    const facade: SubagentAgentFacade = makeFacade({
      ask: async (agentId: string, prompt: string, userId: string) => {
        seen.agentId = agentId;
        seen.prompt = prompt;
        seen.userId = userId;
        return "job-answer";
      },
    });
    const settlement = await makeService(facade).run({
      agentId: "backend",
      prompt: "do it",
      userId: "u1",
      callID: "call-9",
    });
    assert.deepEqual(settlement, {
      callID: "call-9",
      name: "subagent.backend",
      result: "job-answer",
    });
    assert.deepEqual(seen, { agentId: "backend", prompt: "do it", userId: "u1" });
  });

  it("settles failure as an error-result (never throws)", async () => {
    const facade: SubagentAgentFacade = makeFacade({
      ask: async () => {
        throw new Error("job-boom");
      },
    });
    const settlement = await makeService(facade).run({
      agentId: "backend",
      prompt: "do it",
      userId: "u1",
      callID: "call-8",
    });
    assert.deepEqual(settlement, {
      callID: "call-8",
      name: "subagent.backend",
      result: "error: job-boom",
    });
  });

  it("lists only subagent-mode executors", async () => {
    const summaries = makeService(makeFacade()).listExecutors();
    assert.deepEqual(summaries, [{ id: "backend", name: "Backend", description: "backend" }]);
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
    console.error(`${failed}/${cases.length} subagent-job checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${cases.length} subagent-job checks failed`);
  }
  console.log(`${cases.length}/${cases.length} subagent-job checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`subagent-job checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
