/**
 * In-process OpenAI-compatible fetch adapter checks (card C2).
 *
 * Self-contained runner (plain `node:assert`, no network, no new deps):
 *   `bun run build && bun dist/processes/modules/ai/modules/opencode/__tests__/opencode-model-fetch.spec.js`
 * Also executes under `bun run test` (compiled dist specs, top-level run).
 *
 * Every test injects a fake runtime + fake model builder, so `@opencode/ai`
 * is never loaded and no socket is opened. Covered:
 * - non-stream chat with tools → OpenAI `tool_calls` / `finish_reason` / usage
 *   and the mapped `LLMRequest` (`system` separate, tools with `inputSchema`);
 * - non-stream without tools → `finish_reason: "stop"`;
 * - stream → text deltas, tool-call deltas with `index`, final finish chunk
 *   with usage, then `[DONE]`;
 * - missing key → 404 `opencode_key_missing` without any model call;
 * - bad JSON / wrong path / missing model → 400/404;
 * - provider errors → 401/502 with a neutral body (no upstream text).
 */
import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import {
  type OpenAiChatChunk,
  type OpencodeModelFetchDeps,
  type OpencodeRuntime,
  createOpencodeFetch,
} from "../opencode-model-fetch";

type JsonBody = {
  error?: { code?: string; message?: string };
  choices?: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type Captured = {
  generateInput?: Record<string, unknown>;
  streamInput?: Record<string, unknown>;
};

type FakeRuntime = {
  runtime: OpencodeRuntime;
  calls: { generate: number; stream: number; dispose: number };
  captured: Captured;
};

function streamFrom(events: Array<unknown>): AsyncIterable<unknown> {
  return (async function* streamEvents() {
    for (const event of events) yield event;
  })();
}

function fakeRuntime(generateResult: unknown, streamEvents: Array<unknown>): FakeRuntime {
  const calls = { generate: 0, stream: 0, dispose: 0 };
  const captured: Captured = {};
  const runtime: OpencodeRuntime = {
    async generate(input) {
      calls.generate += 1;
      captured.generateInput = input as Record<string, unknown>;
      return generateResult;
    },
    stream(input) {
      calls.stream += 1;
      captured.streamInput = input as Record<string, unknown>;
      return streamFrom(streamEvents);
    },
    async dispose() {
      calls.dispose += 1;
    },
  };
  return { runtime, calls, captured };
}

function invoke(
  adapter: typeof fetch,
  body: unknown,
  path = "/chat/completions",
): Promise<Response> {
  return adapter(`https://opencode.ai/inference/openai/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function baseDeps(runtime: FakeRuntime): OpencodeModelFetchDeps {
  return {
    loadKey: async () => "sk-test",
    makeClient: () => runtime.runtime,
    buildModel: (modelId) => ({ id: modelId, provider: "opencode" }),
    now: () => 1_700_000_000,
    newId: () => "chatcmpl-test",
  };
}

async function nonStreamWithTools(): Promise<void> {
  const fake = fakeRuntime(
    {
      text: "hi",
      toolCalls: [{ type: "tool-call", id: "call_1", name: "git.recon", input: { a: 1 } }],
      events: [
        {
          type: "finish",
          reason: { normalized: "tool-calls" },
          usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        },
      ],
    },
    [],
  );
  const loadCalls: Array<string> = [];
  const buildCalls: Array<{ modelId: string; apiKey: string }> = [];
  const deps: OpencodeModelFetchDeps = {
    ...baseDeps(fake),
    loadKey: async (providerId) => {
      loadCalls.push(providerId);
      return "sk-test";
    },
    buildModel: (modelId, apiKey) => {
      buildCalls.push({ modelId, apiKey });
      return { id: modelId };
    },
  };
  const adapter = createOpencodeFetch(deps);

  const response = await invoke(adapter, {
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
      { role: "user", content: "hi" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "git.recon",
          description: "read-only recon",
          parameters: { type: "object", properties: { a: { type: "number" } } },
        },
      },
    ],
    stream: false,
  });

  assert.equal(response.status, 200, "non-stream returns 200");
  const body = await jsonOf<JsonBody>(response);
  const message = body.choices?.[0]?.message;
  assert.equal(body.choices?.[0]?.finish_reason, "tool_calls");
  assert.equal(message?.content, "hi");
  assert.equal(message?.tool_calls?.[0]?.id, "call_1");
  assert.equal(message?.tool_calls?.[0]?.type, "function");
  assert.equal(message?.tool_calls?.[0]?.function.name, "git.recon");
  assert.equal(message?.tool_calls?.[0]?.function.arguments, '{"a":1}');
  assert.deepEqual(body.usage, {
    prompt_tokens: 3,
    completion_tokens: 5,
    total_tokens: 8,
  });

  const input = fake.captured.generateInput;
  assert.ok(input, "generate() received the mapped request");
  assert.equal(input.system, "sys1\n\nsys2", "system messages are joined separately");
  const mappedMessages = input.messages as Array<{ role: string }>;
  assert.equal(mappedMessages.length, 1, "system messages are not duplicated in messages");
  assert.equal(mappedMessages[0]?.role, "user");
  const tools = input.tools as Array<{
    type: string;
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
  assert.equal(tools[0]?.type, "tool");
  assert.equal(tools[0]?.name, "git.recon");
  assert.deepEqual(tools[0]?.inputSchema, {
    type: "object",
    properties: { a: { type: "number" } },
  });

  assert.deepEqual(loadCalls, ["opencode"], "key is loaded for the opencode provider");
  assert.equal(buildCalls[0]?.modelId, "deepseek-v4.1-flash");
  assert.equal(buildCalls[0]?.apiKey, "sk-test");
  assert.equal(fake.calls.dispose, 1, "runtime is disposed after a non-stream call");
}

async function nonStreamWithoutTools(): Promise<void> {
  const fake = fakeRuntime(
    {
      text: "hi",
      toolCalls: [],
      events: [{ type: "finish", reason: { normalized: "stop" } }],
    },
    [],
  );
  const adapter = createOpencodeFetch(baseDeps(fake));

  const response = await invoke(adapter, {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  assert.equal(response.status, 200);
  const body = await jsonOf<JsonBody>(response);
  assert.equal(body.choices?.[0]?.finish_reason, "stop");
  assert.equal(body.choices?.[0]?.message.content, "hi");
  assert.deepEqual(body.choices?.[0]?.message.tool_calls, []);
  assert.deepEqual(body.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
}

async function streaming(): Promise<void> {
  const fake = fakeRuntime(undefined, [
    { type: "text-delta", id: "t1", text: "Hel" },
    { type: "text-delta", id: "t1", text: "lo" },
    { type: "tool-call", id: "call_1", name: "git.recon", input: { a: 1 } },
    {
      type: "finish",
      reason: { normalized: "tool-calls" },
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    },
  ]);
  const adapter = createOpencodeFetch(baseDeps(fake));

  const response = await invoke(adapter, {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream/,
    "SSE content-type",
  );
  const raw = await response.text();
  const frames = raw
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length));
  assert.equal(frames.at(-1), "[DONE]", "stream ends with [DONE]");

  const chunks = frames
    .slice(0, -1)
    .map((frame) => JSON.parse(frame) as OpenAiChatChunk);
  assert.equal(chunks[0]?.choices[0]?.delta.content, "Hel");
  assert.equal(chunks[1]?.choices[0]?.delta.content, "lo");

  const toolChunk = chunks.find(
    (chunk) => chunk.choices[0]?.delta.tool_calls !== undefined,
  );
  assert.equal(toolChunk?.choices[0]?.delta.tool_calls?.[0]?.index, 0);
  assert.equal(toolChunk?.choices[0]?.delta.tool_calls?.[0]?.id, "call_1");
  assert.equal(toolChunk?.choices[0]?.delta.tool_calls?.[0]?.type, "function");
  assert.equal(
    toolChunk?.choices[0]?.delta.tool_calls?.[0]?.function.arguments,
    '{"a":1}',
  );

  const finish = chunks.at(-1);
  assert.equal(finish?.choices[0]?.finish_reason, "tool_calls");
  assert.equal(finish?.choices[0]?.delta.content, undefined);
  assert.deepEqual(finish?.usage, {
    prompt_tokens: 3,
    completion_tokens: 5,
    total_tokens: 8,
  });
  assert.equal(fake.calls.dispose, 1, "runtime is disposed after the SSE drains");
}

async function missingKey(): Promise<void> {
  const fake = fakeRuntime({ text: "never", toolCalls: [], events: [] }, []);
  const adapter = createOpencodeFetch({
    ...baseDeps(fake),
    loadKey: async () => {
      throw new NotFoundException({
        code: "opencode_key_missing",
        message: "No OpenCode API key configured for this user",
      });
    },
  });

  const response = await invoke(adapter, {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(response.status, 404);
  const body = await jsonOf<JsonBody>(response);
  assert.equal(body.error?.code, "opencode_key_missing");
  assert.equal(fake.calls.generate, 0, "no model call without a key");
  assert.equal(fake.calls.stream, 0, "no stream without a key");
  assert.equal(fake.calls.dispose, 0, "runtime is not created without a key");
}

async function invalidRequests(): Promise<void> {
  let loadCalls = 0;
  const fake = fakeRuntime({ text: "unused", toolCalls: [], events: [] }, []);
  const adapter = createOpencodeFetch({
    ...baseDeps(fake),
    loadKey: async () => {
      loadCalls += 1;
      return "sk-test";
    },
  });

  const badJson = await invoke(adapter, "{");
  assert.equal(badJson.status, 400);
  const badJsonBody = await jsonOf<JsonBody>(badJson);
  assert.equal(badJsonBody.error?.code, "invalid_request");
  assert.equal(badJsonBody.error?.message, "bad JSON body");

  const wrongPath = await invoke(
    adapter,
    { model: "deepseek-v4.1-flash", messages: [] },
    "/models",
  );
  assert.equal(wrongPath.status, 404);
  const wrongPathBody = await jsonOf<JsonBody>(wrongPath);
  assert.equal(wrongPathBody.error?.code, "not_found");

  const noModel = await invoke(adapter, { messages: [] });
  assert.equal(noModel.status, 400);
  const noModelBody = await jsonOf<JsonBody>(noModel);
  assert.equal(noModelBody.error?.code, "invalid_request");

  assert.equal(loadCalls, 0, "invalid requests never touch the key store");
}

async function providerErrors(): Promise<void> {
  const authAdapter = createOpencodeFetch({
    loadKey: async () => "sk-test",
    buildModel: () => ({ id: "fake" }),
    makeClient: () => ({
      async generate() {
        throw Object.assign(new Error("upstream body secret"), {
          _tag: "AuthenticationError",
        });
      },
      stream() {
        throw new Error("not used");
      },
      async dispose() {},
    }),
  });
  const authResponse = await invoke(authAdapter, {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(authResponse.status, 401, "AuthenticationError maps to 401");
  const authText = await authResponse.text();
  assert.equal(
    JSON.parse(authText).error?.code,
    "provider_error",
    "neutral provider error code",
  );
  assert.ok(
    !authText.includes("upstream body secret"),
    "upstream error text is never forwarded",
  );

  const unknownAdapter = createOpencodeFetch({
    loadKey: async () => "sk-test",
    buildModel: () => ({ id: "fake" }),
    makeClient: () => ({
      async generate() {
        throw new Error("boom secret");
      },
      stream() {
        throw new Error("not used");
      },
      async dispose() {},
    }),
  });
  const unknownResponse = await invoke(unknownAdapter, {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(unknownResponse.status, 502, "unknown errors map to 502");
  const unknownText = await unknownResponse.text();
  assert.ok(!unknownText.includes("boom secret"), "raw error text is never forwarded");
}

async function main(): Promise<void> {
  await nonStreamWithTools();
  await nonStreamWithoutTools();
  await streaming();
  await missingKey();
  await invalidRequests();
  await providerErrors();
  console.log("opencode model fetch spec: ok");
}

main().catch((err) => {
  console.error(`opencode model fetch spec: FAIL ${(err as Error).message}`);
  process.exitCode = 1;
  throw err;
});
