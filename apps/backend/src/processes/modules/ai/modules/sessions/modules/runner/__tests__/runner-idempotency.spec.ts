import assert from "node:assert/strict";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import type { CryptoService } from "@common/crypto/crypto.service";
import type { VaultService } from "@common/vault/vault.service";
import type { ModelChainEntry } from "../../../../agents/model-provider";
import type { OpencodeModelFetch } from "../../../../opencode/opencode-model-fetch";
import {
  InMemoryToolEffectsStore,
  ToolDispatchService,
} from "../../../../tool-dispatch/tool-dispatch.service";
import { ToolRegistryService } from "../../../../tool-registry/tool-registry.service";
import type { StepAttempt, StepMeta } from "../loop";
import {
  createStepExecutor,
  type RunTurnRequest,
  SessionTurnRunnerService,
  type StepExecutor,
} from "../runner.service";

/**
 * Runner idempotency (card C7) + attempt audit (card C8): a keyed tool effect
 * runs once across repeated turns, error-results are replayed too, and model
 * attempts are aggregated from every step meta in order.
 */
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

const DIRECTORY = "/tmp/opencode/runner-idempotency";

const ATTEMPT_1: StepAttempt = {
  provider: "p1",
  model: "m1",
  attempt: 1,
  outcome: "ok",
  reason: "ok",
  latencyMs: 5,
};

const ATTEMPT_2: StepAttempt = {
  provider: "p2",
  model: "m2",
  attempt: 1,
  outcome: "switch",
  reason: "not-found",
  latencyMs: 7,
};

/** Runner over one counting `write` handler (no real fs effect). */
function makeRunner(): {
  runner: SessionTurnRunnerService;
  executedCount: () => number;
} {
  const registry = new ToolRegistryService();
  let executed = 0;
  registry.register({
    fullName: "write",
    definition: { name: "write", description: "write", inputSchema: { type: "object" } },
    execute: async () => {
      executed += 1;
      return "wrote once";
    },
  });
  return {
    runner: new SessionTurnRunnerService(new ToolDispatchService(registry)),
    executedCount: () => executed,
  };
}

/** First step asks a `write`, the second step stops (no calls). */
function makeStep(firstMeta?: StepMeta, secondMeta?: StepMeta): StepExecutor {
  let step = 0;
  return async () => {
    step += 1;
    if (step === 1) {
      return {
        text: "",
        calls: [{ id: "c1", name: "write", arguments: "{}" }],
        finishReason: "tool-calls",
        ...(firstMeta !== undefined ? { meta: firstMeta } : {}),
      };
    }
    return {
      text: "done",
      calls: [],
      finishReason: "stop",
      ...(secondMeta !== undefined ? { meta: secondMeta } : {}),
    };
  };
}

function request(
  step: StepExecutor,
  overrides: Partial<RunTurnRequest> = {},
): RunTurnRequest {
  return {
    sessionId: "s1",
    directory: DIRECTORY,
    messages: [],
    step,
    concurrency: 1,
    ...overrides,
  };
}

describe("SessionTurnRunnerService idempotency", () => {
  it("runs a keyed tool effect once for a runId", async () => {
    const { runner, executedCount } = makeRunner();
    const effects = new InMemoryToolEffectsStore();
    const result = await runner.runTurn(request(makeStep(), { runId: "r1", effects }));

    assert.equal(executedCount(), 1);
    assert.deepEqual(result.settlements, [
      { callID: "c1", name: "write", result: "wrote once" },
    ]);
  });

  it("replays the committed settlement on a repeated turn", async () => {
    const { runner, executedCount } = makeRunner();
    const effects = new InMemoryToolEffectsStore();
    const first = await runner.runTurn(request(makeStep(), { runId: "r1", effects }));
    const second = await runner.runTurn(request(makeStep(), { runId: "r1", effects }));

    assert.equal(executedCount(), 1);
    assert.deepEqual(second.settlements, first.settlements);
    assert.deepEqual(second.settlements, [
      { callID: "c1", name: "write", result: "wrote once" },
    ]);
  });

  it("aggregates step attempts in order", async () => {
    const { runner } = makeRunner();
    const effects = new InMemoryToolEffectsStore();
    const firstMeta: StepMeta = {
      provider: "p1",
      model: "m1",
      attempts: [ATTEMPT_1],
      fallback: { attempts: 1 },
    };
    const secondMeta: StepMeta = {
      provider: "p2",
      model: "m2",
      attempts: [ATTEMPT_2],
      fallback: { attempts: 2, switchedFrom: "p1", reason: "not-found" },
    };
    const result = await runner.runTurn(
      request(makeStep(firstMeta, secondMeta), { runId: "r2", effects }),
    );

    assert.deepEqual(result.meta?.attempts, [ATTEMPT_1, ATTEMPT_2]);
    assert.equal(result.meta?.provider, "p2");
    assert.equal(result.meta?.model, "m2");
    assert.deepEqual(result.meta?.fallback, secondMeta.fallback);
  });

  it("answers an empty attempts list when steps report no meta", async () => {
    const { runner } = makeRunner();
    const effects = new InMemoryToolEffectsStore();
    const result = await runner.runTurn(request(makeStep(), { runId: "r3", effects }));

    assert.deepEqual(result.meta, { attempts: [] });
  });

  it("ask mode refuses a mutating call without running the handler", async () => {
    const { runner, executedCount } = makeRunner();
    const effects = new InMemoryToolEffectsStore();
    const result = await runner.runTurn(
      request(makeStep(), { runId: "r4", effects, mode: "ask" }),
    );

    assert.equal(executedCount(), 0);
    assert.equal(
      result.settlements[0]?.result,
      'error: tool "write" is not allowed in ask mode (read-only)',
    );
  });
});

/** One chain candidate (the fake client factory answers it, no network). */
const ENTRY: ModelChainEntry = {
  provider: "opencode",
  transport: "inprocess-opencode",
  model: "fake-model",
  jsonSchema: false,
};

/** One fake client call (messages + the tool choice it was bound with). */
type FakeCall = { messages: Array<unknown>; toolChoice: unknown };

/** Fake ChatOpenAI: answers the queued responses in order, records calls. */
function fakeClient(responses: Array<AIMessage>, calls: Array<FakeCall>): unknown {
  let index = 0;
  return {
    bindTools(_tools: unknown, kwargs?: { tool_choice?: unknown }) {
      return {
        invoke: async (messages: Array<unknown>): Promise<AIMessage> => {
          calls.push({ messages, toolChoice: kwargs?.tool_choice });
          const fallback: AIMessage =
            responses[responses.length - 1] ?? new AIMessage({ content: "" });
          const response: AIMessage = responses[index] ?? fallback;
          index += 1;
          return response;
        },
      };
    },
  };
}

/** Executor deps over a fake client (vault/crypto/fetch are never reached). */
function executorDeps(
  responses: Array<AIMessage>,
  calls: Array<FakeCall>,
): Parameters<typeof createStepExecutor>[0] {
  return {
    userId: "u1",
    system: "SYSTEM-PROMPT",
    tools: [{} as DynamicStructuredTool],
    toolChoiceFromRequest: (stepRequest) => stepRequest.toolChoice,
    chain: [ENTRY],
    keys: {} as VaultService,
    crypto: {} as CryptoService,
    opencodeFetch: {} as OpencodeModelFetch,
    createClient: async () => fakeClient(responses, calls),
  };
}

function textResponse(text: string): AIMessage {
  return new AIMessage({ content: text, response_metadata: { finish_reason: "stop" } });
}

function toolCallResponse(): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ id: "call_1", name: "read", args: { path: "a" }, type: "tool_call" }],
    additional_kwargs: {
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: '{"path":"a"}' },
        },
      ],
    },
    response_metadata: { finish_reason: "tool_calls" },
  });
}

describe("createStepExecutor", () => {
  it("maps a text-only response to a terminal step (no calls)", async () => {
    const calls: Array<FakeCall> = [];
    const step = createStepExecutor(executorDeps([textResponse("hello")], calls));
    const result = await step({ toolChoice: "required" }, [{ role: "user", content: "hi" }]);

    assert.equal(result.text, "hello");
    assert.deepEqual(result.calls, []);
    assert.equal(result.finishReason, "stop");
    assert.equal(result.meta?.model, "fake-model");
    assert.equal(calls.length, 1);
  });

  it("keeps the raw JSON arguments of a tool call (never parses them)", async () => {
    const calls: Array<FakeCall> = [];
    const step = createStepExecutor(executorDeps([toolCallResponse()], calls));
    const result = await step({ toolChoice: "required" }, [{ role: "user", content: "hi" }]);

    assert.deepEqual(result.calls, [
      { id: "call_1", name: "read", arguments: '{"path":"a"}' },
    ]);
    assert.equal(result.finishReason, "tool_calls");
  });

  it("forces tool_choice only on step 0 (required → auto)", async () => {
    const calls: Array<FakeCall> = [];
    const step = createStepExecutor(
      executorDeps([toolCallResponse(), textResponse("done")], calls),
    );
    await step({ toolChoice: "required" }, [{ role: "user", content: "hi" }]);
    await step({ toolChoice: "auto" }, [{ role: "user", content: "hi" }]);

    assert.deepEqual(
      calls.map((call) => call.toolChoice),
      ["required", "auto"],
    );
  });

  it("maps system + history into LangChain messages (system/user/assistant/tool)", async () => {
    const calls: Array<FakeCall> = [];
    const step = createStepExecutor(executorDeps([textResponse("ok")], calls));
    await step({ toolChoice: "auto" }, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read", arguments: '{"path":"a"}' }],
      },
      { role: "tool", content: "file body", toolCallID: "call_1", toolName: "read" },
    ]);

    const sent = calls[0]?.messages ?? [];
    assert.equal(sent.length, 4);
    assert.ok(sent[0] instanceof SystemMessage);
    assert.equal((sent[0] as SystemMessage).content, "SYSTEM-PROMPT");
    assert.ok(sent[1] instanceof HumanMessage);
    assert.ok(sent[2] instanceof AIMessage);
    assert.deepEqual((sent[2] as AIMessage).tool_calls, [
      { id: "call_1", name: "read", args: { path: "a" }, type: "tool_call" },
    ]);
    assert.ok(sent[3] instanceof ToolMessage);
    assert.equal((sent[3] as ToolMessage).tool_call_id, "call_1");
  });

  it("never dispatches a tool (R1: dispatch=0 before the LangChain loop)", async () => {
    const dispatched: Array<unknown> = [];
    const deps = {
      ...executorDeps([toolCallResponse()], []),
      dispatch: (...args: Array<unknown>): void => {
        dispatched.push(args);
      },
    } as Parameters<typeof createStepExecutor>[0];
    const step = createStepExecutor(deps);
    await step({ toolChoice: "required" }, [{ role: "user", content: "hi" }]);

    assert.equal(dispatched.length, 0);
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
