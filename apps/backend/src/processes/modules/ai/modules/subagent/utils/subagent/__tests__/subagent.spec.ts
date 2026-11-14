import assert from "node:assert/strict";
import {
  buildSubagentCallName,
  buildSubagentErrorSettlement,
  buildSubagentSettlement,
} from "../subagent.util";

/**
 * subagent util unit checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/subagent/utils/subagent/__tests__/subagent.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: call-name shape, success settlement passthrough, failure settlement
 * never throws (Error message vs unknown honk).
 */

type Case = { name: string; run: () => void };
const cases: Array<Case> = [];
let suite: string = "";

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = "";
}

function it(name: string, run: () => void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

describe("subagent util", () => {
  it("names calls as subagent.<agentId>", () => {
    assert.equal(buildSubagentCallName("backend"), "subagent.backend");
  });

  it("passes the answer through on success", () => {
    const settlement = buildSubagentSettlement("call-1", "backend", "answer-text");
    assert.deepEqual(settlement, {
      callID: "call-1",
      name: "subagent.backend",
      result: "answer-text",
    });
  });

  it("maps Error to error-result (never throws)", () => {
    const settlement = buildSubagentErrorSettlement("call-2", "frontend", new Error("boom"));
    assert.deepEqual(settlement, {
      callID: "call-2",
      name: "subagent.frontend",
      result: "error: boom",
    });
  });

  it("maps unknown honks to the fixed fallback text", () => {
    const settlement = buildSubagentErrorSettlement("call-3", "fullstack", "honk");
    assert.deepEqual(settlement, {
      callID: "call-3",
      name: "subagent.fullstack",
      result: "error: subagent failed",
    });
  });
});

for (const item of cases) {
  item.run();
  console.log(`ok ${item.name}`);
}
console.log(`done ${cases.length}`);
