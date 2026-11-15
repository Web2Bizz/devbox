/**
 * Model client factory checks — self-contained runner (plain node:assert,
 * no network: `configuration.fetch` is always a fake).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/agents/__tests__/model-client.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers card C2b: one `ChatOpenAI` for every transport —
 * `http-openai` via `baseURL`, `inprocess-opencode` via an injected fetch
 * adapter — including the real OpenAI wire interop (chat completions body,
 * `usage_metadata`) and `bindTools` (`tools[].function`, func not executed).
 */
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { ModelChainEntry } from "../model-provider";
import { createModelClient } from "../model-client";

/** OpenAI-compatible base URL registered for the `openrouter` provider. */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Model id used by the chain in the plan (also used by the fake upstream). */
const TEST_MODEL = "deepseek-v4.1-flash";

/** One request captured by the fake fetch. */
type RecordedRequest = {
  url: string;
  body: Record<string, unknown>;
};

type FetchResponder = (
  body: Record<string, unknown>,
  url: string,
) => unknown | Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function bodyText(body: RequestInit["body"]): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  throw new Error("expected a JSON string request body");
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Fake `fetch` that records the parsed OpenAI request and answers through the
 * responder. Nothing leaves the process.
 */
function recordingFetch(responder: FetchResponder): {
  fetchFn: typeof fetch;
  calls: Array<RecordedRequest>;
} {
  const calls: Array<RecordedRequest> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    const parsed: unknown = JSON.parse(bodyText(init?.body));
    if (!isRecord(parsed)) {
      throw new Error("request body is not a JSON object");
    }
    calls.push({ url, body: parsed });
    return jsonResponse(await responder(parsed, url));
  };
  return { fetchFn, calls };
}

/** Minimal OpenAI non-streaming chat completion (the fields we assert on). */
function chatCompletion(model: string, content: string): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  };
}

function httpEntry(
  overrides: Partial<ModelChainEntry> = {},
): ModelChainEntry {
  return {
    provider: "openrouter",
    transport: "http-openai",
    baseURL: OPENROUTER_BASE_URL,
    model: TEST_MODEL,
    jsonSchema: false,
    ...overrides,
  };
}

function inprocessEntry(
  overrides: Partial<ModelChainEntry> = {},
): ModelChainEntry {
  return {
    provider: "opencode",
    transport: "inprocess-opencode",
    model: TEST_MODEL,
    jsonSchema: false,
    ...overrides,
  };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Effective LangChain retry budget. `AsyncCaller.maxRetries` is protected in
 * the typings, so the spec reads it structurally (a plain cast, no mutation).
 */
function callerMaxRetries(client: ChatOpenAI): number | undefined {
  const caller = (client as unknown as { caller?: { maxRetries?: number } })
    .caller;
  return caller?.maxRetries;
}

type Check = {
  name: string;
  run: () => void | Promise<void>;
};

const checks: Array<Check> = [
  {
    name: "http-openai: standard ChatOpenAI bound to baseURL, no SDK retries",
    run: () => {
      const entry = httpEntry();
      const client = createModelClient(entry, "sk-openrouter-user");
      assert.ok(client instanceof ChatOpenAI);
      assert.equal(client.model, entry.model);
      assert.equal(client.clientConfig.baseURL, OPENROUTER_BASE_URL);
      // Retries are 0 on both layers: the LangChain `AsyncCaller` (default 6
      // when `maxRetries` is not forwarded) and the OpenAI SDK client options.
      assert.equal(callerMaxRetries(client), 0);
      assert.equal(client.clientConfig.maxRetries, 0);
      // `@langchain/openai@1.8.2` does not mirror `maxRetries` onto the
      // ChatOpenAI instance, so the effective budget is asserted above; this
      // probe catches a future instance-level field drifting from 0.
      const instanceMaxRetries = (
        client as unknown as { maxRetries?: number }
      ).maxRetries;
      assert.equal(instanceMaxRetries ?? callerMaxRetries(client), 0);
      assert.equal(client.useResponsesApi, false);
    },
  },
  {
    name: "inprocess-opencode: fetch adapter attached to the client config",
    run: () => {
      const entry = inprocessEntry();
      const { fetchFn, calls } = recordingFetch(() =>
        chatCompletion(entry.model, "pong"),
      );
      const client = createModelClient(entry, "sk-opencode-user", {
        fetch: fetchFn,
      });
      assert.ok(client instanceof ChatOpenAI);
      assert.equal(client.model, entry.model);
      assert.equal(client.clientConfig.fetch, fetchFn);
      assert.equal(callerMaxRetries(client), 0);
      assert.equal(client.clientConfig.maxRetries, 0);
      assert.equal(client.useResponsesApi, false);
      assert.equal(calls.length, 0);
    },
  },
  {
    name: "inprocess-opencode without a fetch adapter throws",
    run: () => {
      const error = captureError(() =>
        createModelClient(inprocessEntry(), "sk-opencode-user"),
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /in-process transport requires a fetch adapter/);
    },
  },
  {
    name: "http-openai without baseURL throws",
    run: () => {
      const error = captureError(() =>
        createModelClient(httpEntry({ baseURL: undefined }), "sk-openrouter"),
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /http-openai provider requires baseURL/);
    },
  },
  {
    name: "blank apiKey throws (http and in-process)",
    run: () => {
      const httpError = captureError(() =>
        createModelClient(httpEntry(), "   "),
      );
      assert.ok(httpError instanceof Error);
      assert.match(httpError.message, /apiKey is required for a model client/);

      const { fetchFn } = recordingFetch(() => chatCompletion(TEST_MODEL, "x"));
      const inprocessError = captureError(() =>
        createModelClient(inprocessEntry(), "", { fetch: fetchFn }),
      );
      assert.ok(inprocessError instanceof Error);
      assert.match(
        inprocessError.message,
        /apiKey is required for a model client/,
      );
    },
  },
  {
    name: "unknown transport throws",
    run: () => {
      const broken = {
        ...httpEntry(),
        transport: "carrier-pigeon",
      } as unknown as ModelChainEntry;
      const error = captureError(() =>
        createModelClient(broken, "sk-openrouter-user"),
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /Unsupported model transport/);
      assert.match(error.message, /carrier-pigeon/);
    },
  },
  {
    name: "interop: invoke → /chat/completions, AIMessage content + usage",
    run: async () => {
      const entry = inprocessEntry();
      const { fetchFn, calls } = recordingFetch((body) => {
        assert.equal(body.model, entry.model);
        assert.notEqual(body.stream, true);
        return chatCompletion(entry.model, "pong");
      });
      const client = createModelClient(entry, "sk-opencode-user", {
        fetch: fetchFn,
      });

      const message = await client.invoke("ping");

      assert.ok(message instanceof AIMessage);
      assert.equal(message.content, "pong");
      assert.equal(calls.length, 1);
      assert.ok(calls[0]?.url.endsWith("/chat/completions"));
      const usage = message.usage_metadata;
      assert.ok(usage);
      assert.equal(usage.input_tokens, 3);
      assert.equal(usage.output_tokens, 5);
      assert.equal(usage.total_tokens, 8);
    },
  },
  {
    name: "bind_tools: function tool on the wire, func never executed",
    run: async () => {
      let funcCalls = 0;
      const recon = tool(
        async () => {
          funcCalls += 1;
          return "recon-result";
        },
        {
          name: "git.recon",
          description: "read-only recon",
          schema: z.object({ path: z.string() }),
        },
      );

      const entry = inprocessEntry();
      const { fetchFn, calls } = recordingFetch((body) => {
        const tools: unknown = body.tools;
        assert.ok(Array.isArray(tools));
        const first = tools[0] as Record<string, unknown>;
        assert.equal(first.type, "function");
        const fn = first.function as Record<string, unknown>;
        assert.equal(fn.name, "git.recon");
        const parameters = fn.parameters as Record<string, unknown>;
        assert.equal(parameters.type, "object");
        return chatCompletion(entry.model, "pong");
      });

      const client = createModelClient(entry, "sk-opencode-user", {
        fetch: fetchFn,
      });
      const bound = client.bindTools([recon]);
      const message = await bound.invoke("ping");

      assert.equal(message.content, "pong");
      assert.equal(funcCalls, 0);
      assert.equal(calls.length, 1);
      assert.ok(calls[0]?.url.endsWith("/chat/completions"));
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
    console.error(`${failed}/${checks.length} model client checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} model client checks failed`);
  }
  console.log(`${checks.length}/${checks.length} model client checks passed`);
}

void main().catch((error: unknown) => {
  console.error(
    `model client checks failed to run: ${(error as Error).message}`,
  );
  process.exit(1);
});
