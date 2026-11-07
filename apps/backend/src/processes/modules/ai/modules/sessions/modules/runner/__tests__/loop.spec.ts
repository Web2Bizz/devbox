import assert from "node:assert/strict";
import {
  addUsage,
  collect,
  IncompleteStreamError,
  nextRequest,
  pendingCalls,
  stepMessages,
  type LoopStep,
  type TurnFrame,
} from "../loop";
import { assertStepBudget, MaxStepsExceededError } from "../max-steps";
import { withRetry } from "../retry";

/** Pure loop fold/budget/retry semantics — no transport, no DI. */
type Case = { name: string; run: () => Promise<void> | void };
const cases: Array<Case> = [];
let suite = "";

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

const CALL = { id: "c1", name: "read", arguments: '{"path":"a"}' };

describe("pendingCalls", () => {
  it("keeps ordinary calls", () => {
    const step: LoopStep = { text: "", calls: [CALL], finishReason: "tool-calls" };
    assert.deepEqual(pendingCalls(step), [CALL]);
  });

  it("answerTool is terminal", () => {
    const step: LoopStep = {
      text: "",
      calls: [{ ...CALL, name: "answerTool" }],
      finishReason: "tool-calls",
    };
    assert.deepEqual(pendingCalls(step), []);
  });

  it("length finish is terminal even with calls", () => {
    const step: LoopStep = { text: "", calls: [CALL], finishReason: "length" };
    assert.deepEqual(pendingCalls(step), []);
  });
});

describe("nextRequest", () => {
  it("forces tool choice only on the first step", () => {
    assert.equal(nextRequest({ text: "", calls: [], finishReason: null }, 0).toolChoice, "required");
    assert.equal(nextRequest({ text: "", calls: [], finishReason: null }, 1).toolChoice, "auto");
  });
});

describe("stepMessages", () => {
  it("echoes the assistant text and one tool row per settlement", () => {
    const rows = stepMessages({ text: "hi", calls: [], finishReason: null }, [
      { callID: "c1", name: "read", result: "alpha" },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.role, "assistant");
    assert.equal(rows[1]?.toolCallID, "c1");
    assert.equal(rows[1]?.content, "alpha");
  });
});

describe("addUsage", () => {
  it("folds counters and keeps absent ones absent", () => {
    const total = addUsage({ input: 1, output: 2 }, { input: 3, output: 4, reasoning: 5 });
    assert.deepEqual(total, { input: 4, output: 6, reasoning: 5 });
  });

  it("returns the same total without usage", () => {
    const total = { input: 1, output: 2 };
    assert.equal(addUsage(total, undefined), total);
  });
});

describe("collect", () => {
  it("folds a complete turn", () => {
    const frames: Array<TurnFrame> = [
      { type: "step-start", data: {} },
      { type: "tool-result", data: { callID: "c1", name: "read", result: "a" } },
      { type: "step-finish", data: { finishReason: "tool-calls" } },
      { type: "step-start", data: {} },
      { type: "finish", data: { finishReason: "stop", text: "done" } },
    ];
    const turn = collect(frames);
    assert.equal(turn.steps, 2);
    assert.equal(turn.finishReason, "stop");
    assert.equal(turn.text, "done");
    assert.equal(turn.toolResults.length, 1);
  });

  it("a stream without a finish frame is incomplete", () => {
    assert.throws(
      () => collect([{ type: "step-start", data: {} }]),
      (err: unknown) => err instanceof IncompleteStreamError,
    );
  });
});

describe("max-steps", () => {
  it("refuses an exhausted budget", () => {
    assert.throws(() => assertStepBudget(2, 2), (err: unknown) => err instanceof MaxStepsExceededError);
    assert.doesNotThrow(() => assertStepBudget(1, 2));
  });
});

describe("withRetry", () => {
  it("retries up to the bounded attempt count", async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await withRetry(
        async () => {
          calls += 1;
          throw new Error("boom");
        },
        { attempts: 3, delayMs: 1 },
      );
    });
    assert.equal(calls, 3);
  });

  it("stops on a non-retryable error", async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await withRetry(
        async () => {
          calls += 1;
          throw new Error("stop");
        },
        { attempts: 5, delayMs: 1, shouldRetry: () => false },
      );
    });
    assert.equal(calls, 1);
  });
});

async function main(): Promise<void> {
  for (const item of cases) {
    await item.run();
    console.log(`ok ${item.name}`);
  }
  console.log(`done ${cases.length}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
