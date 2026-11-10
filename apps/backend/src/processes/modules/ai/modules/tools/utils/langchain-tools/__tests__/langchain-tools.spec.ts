/**
 * LangChain tool bindings (card C3) — self-contained runner (plain
 * `node:assert`, no network, no filesystem).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/tools/utils/langchain-tools/__tests__/langchain-tools.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: every `ToolView` becomes exactly one `DynamicStructuredTool` with a
 * wire-safe unique name; `executeToolView` keeps dispatch as the only native
 * settlement point (worker ids and MCP are resolved before it); mutation flags
 * are fail-closed; the subagent is a LangChain tool with an error-result.
 */
import assert from "node:assert/strict";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { ToolView } from "@rush-code/contracts";
import {
  createLangChainTools,
  createMcpLangChainTools,
  createSubagentLangChainTool,
  executeToolView,
  filterLangChainToolsForMode,
  isMutatingToolView,
  type ToolViewExecutorDeps,
  wireToolName,
} from "../langchain-tools.util";
import type { ToolCall } from "../../../../tool-runtime/tool-runtime.types";

/** OpenAI-safe function name: `^[A-Za-z0-9_-]{1,64}$`. */
const WIRE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Any object input (no required fields). */
const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
};

/** Object input with one required field. */
const PATH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

type RecordedDispatch = { id: string; name: string; arguments: string };

type FakeDeps = {
  deps: ToolViewExecutorDeps;
  dispatchCalls: Array<RecordedDispatch>;
};

type RecordedSubagentRequest = {
  agentId: string;
  prompt: string;
  userId: string;
  correlationId?: string;
  callID?: string;
};

function makeView(
  id: string,
  inputSchema: Record<string, unknown> = PATH_SCHEMA,
): ToolView {
  return { id, title: id, description: `${id} description`, inputSchema };
}

/** Dispatch fake that records the exact calls and settles a predictable text. */
function fakeDeps(overrides: Partial<ToolViewExecutorDeps> = {}): FakeDeps {
  const dispatchCalls: Array<RecordedDispatch> = [];
  const deps: ToolViewExecutorDeps = {
    dispatch: async (calls: Array<ToolCall>) => {
      for (const call of calls) {
        dispatchCalls.push({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      return calls.map((call) => ({
        callID: call.id,
        name: call.name,
        result: `dispatch:${call.name}`,
      }));
    },
    context: { directory: "/tmp/opencode/langchain-tools", sessionId: "s1" },
    ...overrides,
  };
  return { deps, dispatchCalls };
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [];

function it(name: string, run: () => Promise<void>): void {
  cases.push({ name, run });
}

it("binds every view to a DynamicStructuredTool with a unique wire-safe name", async () => {
  const views: Array<ToolView> = [
    makeView("native:read"),
    makeView("native:git.recon", EMPTY_OBJECT_SCHEMA),
    makeView("mcp:search", EMPTY_OBJECT_SCHEMA),
    makeView("native:write"),
    makeView("native:git/recon", EMPTY_OBJECT_SCHEMA),
  ];
  const { deps } = fakeDeps();
  const bindings = createLangChainTools(views, deps);

  assert.equal(bindings.length, views.length);
  bindings.forEach((binding, index) => {
    assert.ok(binding.tool instanceof DynamicStructuredTool);
    assert.match(binding.wireName, WIRE_NAME);
    assert.equal(binding.tool.name, binding.wireName);
    assert.equal(binding.view.id, views[index]?.id);
  });

  const names = bindings.map((binding) => binding.wireName);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names[1], "native_git_recon");
  assert.notEqual(names[1], names[4]);
  assert.equal(names[4], "native_git_recon_2");
});

it("native:read goes through dispatch with the same call shape", async () => {
  const { deps, dispatchCalls } = fakeDeps();
  const [binding] = createLangChainTools([makeView("native:read")], deps);
  assert.ok(binding);

  const result = await binding.tool.invoke({ path: "x" });

  assert.equal(result, "dispatch:read");
  assert.deepEqual(dispatchCalls, [
    { id: "native:read", name: "read", arguments: '{"path":"x"}' },
  ]);
});

it("wireNameFor lets native views travel under their bare registry name", async () => {
  const { deps } = fakeDeps();
  const bindings = createLangChainTools(
    [makeView("native:read"), makeView("native:write"), makeView("mcp:search", EMPTY_OBJECT_SCHEMA)],
    deps,
    { wireNameFor: (view) => (view.id.startsWith("native:") ? view.id.slice("native:".length) : view.id) },
  );

  assert.deepEqual(
    bindings.map((binding) => binding.wireName),
    ["read", "write", "mcp_search"],
  );
  assert.deepEqual(
    bindings.map((binding) => binding.view.id),
    ["native:read", "native:write", "mcp:search"],
  );
});

it("native:git.recon declared by the worker skips dispatch", async () => {
  const workerCalls: Array<{
    id: string;
    input: Record<string, unknown>;
    cwd: string;
  }> = [];
  const { deps, dispatchCalls } = fakeDeps({
    context: { directory: "/project" },
    worker: {
      async invoke(id, input, ctx) {
        workerCalls.push({ id, input, cwd: ctx.cwd });
        return { output: { commits: 3 } };
      },
    },
    workerIds: new Set(["native:git.recon"]),
  });
  const [binding] = createLangChainTools(
    [makeView("native:git.recon", EMPTY_OBJECT_SCHEMA)],
    deps,
  );
  assert.ok(binding);

  const result = await binding.tool.invoke({});

  assert.equal(result, '{"commits":3}');
  assert.deepEqual(workerCalls, [
    { id: "native:git.recon", input: {}, cwd: "/project" },
  ]);
  assert.equal(dispatchCalls.length, 0);
});

it("mcp:search calls the MCP client and returns JSON", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { deps, dispatchCalls } = fakeDeps({
    mcp: {
      async callTool(name, args) {
        calls.push({ name, args });
        return { content: [{ type: "text", text: "hit" }] };
      },
    },
  });
  const [binding] = createLangChainTools(
    [
      makeView("mcp:search", {
        type: "object",
        properties: { query: { type: "string" } },
      }),
    ],
    deps,
  );
  assert.ok(binding);

  const result = await binding.tool.invoke({ query: "hello" });

  assert.equal(result, JSON.stringify({ content: [{ type: "text", text: "hit" }] }));
  assert.deepEqual(calls, [{ name: "search", args: { query: "hello" } }]);
  assert.equal(dispatchCalls.length, 0);
});

it("mcp answers error-results without a client or on failure", async () => {
  const orphan = fakeDeps();
  const [withoutClient] = createLangChainTools(
    [makeView("mcp:search", EMPTY_OBJECT_SCHEMA)],
    orphan.deps,
  );
  assert.ok(withoutClient);
  assert.equal(
    await withoutClient.tool.invoke({}),
    "error: mcp client is not configured",
  );

  const failing = fakeDeps({
    mcp: {
      async callTool() {
        throw new Error("boom");
      },
    },
  });
  const [withClient] = createLangChainTools(
    [makeView("mcp:search", EMPTY_OBJECT_SCHEMA)],
    failing.deps,
  );
  assert.ok(withClient);
  assert.equal(await withClient.tool.invoke({}), "error: boom");
});

it("required schema fields are validated before the tool runs", async () => {
  const { deps, dispatchCalls } = fakeDeps();
  const [binding] = createLangChainTools([makeView("native:read")], deps);
  assert.ok(binding);

  await assert.rejects(
    () => binding.tool.invoke({}),
    /did not match expected schema/,
  );
  assert.equal(dispatchCalls.length, 0);
});

it("non-native prefixes dispatch under the full view id", async () => {
  const { deps, dispatchCalls } = fakeDeps();

  const result = await executeToolView(
    makeView("skill:review", EMPTY_OBJECT_SCHEMA),
    { a: 1 },
    deps,
  );

  assert.equal(result, "dispatch:skill:review");
  assert.deepEqual(dispatchCalls, [
    { id: "skill:review", name: "skill:review", arguments: '{"a":1}' },
  ]);
});

it("mutating table is fail-closed", async () => {
  const readOnly = new Map<string, boolean>([
    ["search", true],
    ["delete", false],
  ]);
  const expectations: Array<[string, boolean]> = [
    ["native:read", false],
    ["native:glob", false],
    ["native:grep", false],
    ["native:todo", false],
    ["native:git.recon", false],
    ["native:write", true],
    ["native:edit", true],
    ["native:patch", true],
    ["native:shell", true],
    ["native:git.commit", true],
    ["mcp:search", false],
    ["mcp:delete", true],
    ["mcp:unknown", true],
    ["skill:review", true],
    ["subagent.reviewer", true],
  ];

  for (const [id, expected] of expectations) {
    assert.equal(isMutatingToolView(makeView(id), readOnly), expected, id);
  }
});

it("filterLangChainToolsForMode keeps only read-only bindings in ask mode", async () => {
  const readOnly = new Map<string, boolean>([
    ["search", true],
    ["delete", false],
  ]);
  const { deps } = fakeDeps({ mcpReadOnly: readOnly });
  const bindings = createLangChainTools(
    [
      makeView("native:read", EMPTY_OBJECT_SCHEMA),
      makeView("native:glob", EMPTY_OBJECT_SCHEMA),
      makeView("native:grep", EMPTY_OBJECT_SCHEMA),
      makeView("native:todo", EMPTY_OBJECT_SCHEMA),
      makeView("native:git.recon", EMPTY_OBJECT_SCHEMA),
      makeView("mcp:search", EMPTY_OBJECT_SCHEMA),
      makeView("native:write", EMPTY_OBJECT_SCHEMA),
      makeView("native:shell", EMPTY_OBJECT_SCHEMA),
      makeView("mcp:delete", EMPTY_OBJECT_SCHEMA),
      makeView("skill:review", EMPTY_OBJECT_SCHEMA),
    ],
    deps,
  );

  const ask = filterLangChainToolsForMode(bindings, "ask");
  assert.deepEqual(
    ask.map((binding) => binding.view.id),
    [
      "native:read",
      "native:glob",
      "native:grep",
      "native:todo",
      "native:git.recon",
      "mcp:search",
    ],
  );

  const auto = filterLangChainToolsForMode(bindings, "auto");
  assert.deepEqual(
    auto.map((binding) => binding.view.id),
    bindings.map((binding) => binding.view.id),
  );
});

it("subagent runs as a LangChain tool and forwards agent/user/correlation", async () => {
  const requests: Array<RecordedSubagentRequest> = [];
  const { tool, wireName, mutating } = createSubagentLangChainTool(
    {
      async run(request) {
        requests.push(request);
        return {
          callID: request.callID ?? "call-1",
          name: `subagent.${request.agentId}`,
          result: "answer from reviewer",
        };
      },
    },
    { agentId: "reviewer", userId: "u-1", correlationId: "cid-1" },
  );

  assert.ok(tool instanceof DynamicStructuredTool);
  assert.match(wireName, WIRE_NAME);
  assert.equal(wireName, "subagent_reviewer");
  assert.equal(mutating, true);
  assert.equal(await tool.invoke({ prompt: "hi" }), "answer from reviewer");
  assert.deepEqual(requests, [
    {
      agentId: "reviewer",
      prompt: "hi",
      userId: "u-1",
      correlationId: "cid-1",
    },
  ]);
});

it("subagent failure is an error-result, not a throw", async () => {
  const { tool } = createSubagentLangChainTool(
    {
      async run() {
        throw new Error("subagent exploded");
      },
    },
    { agentId: "reviewer", userId: "u-1" },
  );

  assert.equal(
    await tool.invoke({ prompt: "hi" }),
    "error: subagent exploded",
  );
});

it("subagent rejects an empty prompt", async () => {
  const { tool } = createSubagentLangChainTool(
    {
      async run() {
        throw new Error("must not run");
      },
    },
    { agentId: "reviewer", userId: "u-1" },
  );

  await assert.rejects(
    () => tool.invoke({ prompt: "" }),
    /did not match expected schema/,
  );
});

it("MCP factory binds descriptors with read-only hints", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const bindings = createMcpLangChainTools(
    {
      async callTool(name, args) {
        calls.push({ name, args });
        return { ok: true };
      },
    },
    [
      {
        name: "search",
        description: "Search docs",
        inputSchema: EMPTY_OBJECT_SCHEMA,
        readOnly: true,
      },
      { name: "delete" },
    ],
  );

  assert.equal(bindings.length, 2);
  assert.deepEqual(
    bindings.map((binding) => binding.view.id),
    ["mcp:search", "mcp:delete"],
  );
  assert.equal(bindings[0]?.view.title, "search");
  assert.equal(bindings[0]?.view.description, "Search docs");
  assert.equal(bindings[1]?.view.description, "delete");
  assert.equal(bindings[0]?.mutating, false);
  assert.equal(bindings[1]?.mutating, true);
  bindings.forEach((binding) => {
    assert.ok(binding.tool instanceof DynamicStructuredTool);
    assert.match(binding.wireName, WIRE_NAME);
  });

  assert.equal(await bindings[0]?.tool.invoke({}), '{"ok":true}');
  assert.deepEqual(calls, [{ name: "search", args: {} }]);
});

it("unsupported input schemas fall back instead of breaking the tool set", async () => {
  const { deps } = fakeDeps();
  const brokenRef = makeView("native:read", {
    $ref: "#/$defs/Missing",
    $defs: {},
  });
  const nonObject = {
    id: "skill:legacy",
    title: "legacy",
    description: "legacy",
    inputSchema: "not-an-object",
  } as unknown as ToolView;

  const bindings = createLangChainTools([brokenRef, nonObject], deps);

  assert.equal(bindings.length, 2);
  bindings.forEach((binding) => {
    assert.ok(binding.tool instanceof DynamicStructuredTool);
    assert.match(binding.wireName, WIRE_NAME);
  });
  assert.equal(
    await bindings[1]?.tool.invoke({ any: "thing" }),
    "dispatch:skill:legacy",
  );
});

it("wireToolName sanitizes, caps and never returns an empty name", async () => {
  assert.equal(wireToolName("native:git.recon"), "native_git_recon");
  assert.equal(wireToolName(""), "tool");
  assert.equal(wireToolName("!!!"), "___");
  const long = wireToolName(`native:${"a".repeat(200)}`);
  assert.equal(long.length, 64);
  assert.match(long, WIRE_NAME);
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
