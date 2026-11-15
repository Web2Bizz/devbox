import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { CryptoService } from "@common/crypto/crypto.service";
import { OPENCODE_PROVIDER } from "@common/vault/vault.providers";
import { VaultService } from "@common/vault/vault.service";
import { type ModelProviderKeyDeps, loadProviderKey } from "../agents/model-provider";

/**
 * SCOPE: Processes → AI → OpenCode — in-process OpenAI-compatible fetch
 * adapter (card C2, transport `inprocess-opencode`).
 *
 * The model layer talks OpenAI wire (`ChatOpenAI` in the agent layer). This
 * factory turns one OpenAI `POST /chat/completions` request into one
 * `@opencode/ai` call, in process, with a per-call user key and no HTTP hop:
 *
 *   ChatOpenAI ──(configuration.fetch)──▶ createOpencodeFetch()
 *      ──▶ openai-compatible model(id, { apiKey, baseURL, provider })
 *      ──▶ make().generate/stream()
 *      ──▶ opencode.ai/inference/openai/v1/chat/completions
 *
 * Invariants:
 * - `tools: []` means no tools; when tools arrive they are only forwarded as
 *   `ToolDefinition`s. Nothing is executed here: `ToolDispatchService` is
 *   intentionally NOT imported (R1).
 * - The plaintext key lives in memory for the duration of one call; it is
 *   never logged, never placed into an error body, never persisted.
 * - Provider failures are mapped to neutral HTTP answers
 *   (`{ error: { code: "provider_error", message: "model provider failed" } }`)
 *   without upstream text, request body or key material.
 * - No config files, no port, no sidecar, no new dependencies.
 */

/** OpenAI-compatible chat base URL of the official Inference API. */
export const OPENCODE_CHAT_BASE_URL: string = "https://opencode.ai/inference/openai/v1";

/** Upstream provider id passed to the openai-compatible route. */
export const OPENCODE_UPSTREAM_PROVIDER: string = "opencode";

/** OpenAI tool entry (function tools only). */
export type OpenAiTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/** OpenAI content part (text only; the adapter does not carry media here). */
export type OpenAiContentPart = { type: "text"; text: string };

/** OpenAI tool call emitted by an assistant message. */
export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** OpenAI chat message (request and response shape). */
export type OpenAiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<OpenAiContentPart> | null;
  tool_calls?: Array<OpenAiToolCall>;
  tool_call_id?: string;
  name?: string;
};

/** OpenAI `POST /chat/completions` request body (the subset we map). */
export type OpenAiChatRequest = {
  model: string;
  messages: Array<OpenAiMessage>;
  tools?: Array<OpenAiTool>;
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
};

/** OpenAI usage block. */
export type OpenAiUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

/** OpenAI non-streaming chat completion response. */
export type OpenAiChatResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<OpenAiToolCall>;
    };
    finish_reason: "stop" | "length" | "tool_calls";
  }>;
  usage: OpenAiUsage;
};

/** OpenAI streaming chunk (one SSE `data:` frame). */
export type OpenAiChatChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | null;
  }>;
  usage?: OpenAiUsage;
};

/** Structural view of one `LLMEvent` (only the fields the adapter reads). */
type OpencodeStreamEvent = {
  type?: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  reason?: { normalized?: unknown };
  usage?: unknown;
};

/** Structural view of one tool call from `LLMResponse.toolCalls`. */
type OpencodeToolCall = { id: string; name: string; input?: unknown };

/** Structural view of `LLMResponse` (only the fields the adapter reads). */
type OpencodeGenerateResponse = {
  text?: unknown;
  toolCalls?: unknown;
  events?: unknown;
};

/** Promise-first `@opencode/ai` runtime (`make()` result, structural subset). */
export type OpencodeRuntime = {
  generate: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  stream: (input: unknown, options?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  dispose: () => Promise<void>;
};

/** Injectable dependencies of the adapter (pure factory, test-friendly). */
export type OpencodeModelFetchDeps = {
  /** Per-user plaintext key for one provider (never logged). */
  loadKey: (providerId: string) => Promise<string>;
  /** Override the runtime factory (`make()`); tests inject a fake. */
  makeClient?: () => OpencodeRuntime;
  /** Override the LanguageModel builder (openai-compatible route). */
  buildModel?: (modelId: string, apiKey: string) => unknown;
  /** Override the clock (seconds in the OpenAI envelope). */
  now?: () => number;
  /** Override the response id generator. */
  newId?: () => string;
};

/** Minimal `LLMRequest` shapes produced by the mapper. */
type LlmSystemPart = { type: "text"; text: string };
type LlmTextPart = { type: "text"; text: string };
type LlmToolCallPart = {
  type: "tool-call";
  id: string;
  name: string;
  input: unknown;
};
type LlmToolResultPart = {
  type: "tool-result";
  id: string;
  name: string;
  result: { type: "text"; value: string };
};
type LlmMessage = {
  role: "user" | "assistant" | "tool";
  content: Array<LlmTextPart | LlmToolCallPart | LlmToolResultPart>;
};

/** A neutral provider failure body: no upstream text, no key, no URL. */
type ProviderErrorBody = {
  error: { code: 'provider_error'; message: 'model provider failed' };
};

const PROVIDER_ERROR_BODY: ProviderErrorBody = {
  error: { code: 'provider_error', message: 'model provider failed' },
};

/** Base URL used only to parse relative request targets locally. */
const LOCAL_PARSE_BASE_URL: string = 'http://localhost';

/** Body type accepted by the global `Response` constructor. */
type ResponseBody = ConstructorParameters<typeof Response>[0];

/** Normalized token counts (zeros when the provider reported nothing). */
type NormalizedUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function badRequest(message: string): Response {
  return jsonResponse({ error: { code: "invalid_request", message } }, 400);
}

function notFound(): Response {
  return jsonResponse({ error: { code: "not_found" } }, 404);
}

/** Extract the request target (string, URL or Request object). */
function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** URL path without query/hash; the adapter only serves `/chat/completions`. */
function pathOf(url: string): string {
  const withoutQuery: string = url.split("?")[0]?.split("#")[0] ?? "";
  try {
    return new URL(withoutQuery, LOCAL_PARSE_BASE_URL).pathname;
  } catch {
    return withoutQuery;
  }
}

/** Decode the request body; `null` means "not a JSON string we can read". */
function readBody(body: RequestInit["body"]): string | null {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (body instanceof URLSearchParams) return body.toString();
  return null;
}

/** Concatenate text parts of an OpenAI message content value. */
function contentText(
  content: string | Array<OpenAiContentPart> | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/**
 * Map OpenAI `tools` to `ToolDefinition` inputs. Non-function entries are
 * skipped; the OpenAI wire type only carries function tools here anyway.
 */
function mapTools(tools: Array<OpenAiTool> | undefined): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return [];
  const mapped: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== 'function') continue;
    const toolFunction: OpenAiTool['function'] = tool.function;
    if (!isRecord(toolFunction) || typeof toolFunction.name !== 'string' || toolFunction.name.length === 0) {
      continue;
    }
    mapped.push({
      type: 'tool',
      name: toolFunction.name,
      description: typeof toolFunction.description === 'string' ? toolFunction.description : '',
      inputSchema: isRecord(toolFunction.parameters)
        ? toolFunction.parameters
        : { type: 'object', properties: {} },
    });
  }
  return mapped;
}

/** Parse assistant tool-call arguments; broken JSON degrades to `{}`. */
function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** Map OpenAI messages into `LLMRequest.system` + `LLMRequest.messages`. */
function mapMessages(messages: Array<OpenAiMessage>): {
  system?: string;
  messages: Array<LlmMessage>;
} {
  const systemParts: Array<string> = [];
  const mapped: Array<LlmMessage> = [];

  for (const message of messages) {
    if (!isRecord(message) || typeof message.role !== 'string') continue;
    if (message.role === 'system') {
      const text: string = contentText(message.content);
      if (text.length > 0) systemParts.push(text);
      continue;
    }

    if (message.role === 'tool') {
      const id: string = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      const name: string = typeof message.name === 'string' ? message.name : id;
      mapped.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id,
            name,
            result: { type: 'text', value: contentText(message.content) },
          },
        ],
      });
      continue;
    }

    if (message.role !== 'user' && message.role !== 'assistant') continue;

    const parts: Array<LlmTextPart | LlmToolCallPart> = [];
    const text: string = contentText(message.content);
    if (text.length > 0) parts.push({ type: 'text', text });
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        const id: string = typeof call.id === 'string' ? call.id : '';
        const name: string = typeof call.function.name === 'string' ? call.function.name : '';
        if (id.length === 0 || name.length === 0) continue;
        parts.push({
          type: 'tool-call',
          id,
          name,
          input: parseArguments(call.function.arguments),
        });
      }
    }
    mapped.push({ role: message.role, content: parts });
  }

  const system: string | undefined = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  return system === undefined ? { messages: mapped } : { system, messages: mapped };
}

/** Map `temperature`/`max_tokens` onto `GenerationOptions` (verified fields). */
function mapGeneration(request: OpenAiChatRequest): Record<string, number> | undefined {
  const generation: Record<string, number> = {};
  if (typeof request.temperature === 'number') generation.temperature = request.temperature;
  const maxTokens: number | undefined = request.max_tokens ?? request.max_completion_tokens;
  if (typeof maxTokens === 'number') generation.maxTokens = maxTokens;
  return Object.keys(generation).length > 0 ? generation : undefined;
}

/** Read the last `finish`/`step-finish` usage from `LLMResponse.events`. */
function usageFromEvents(events: unknown): NormalizedUsage {
  let usage: Record<string, unknown> | undefined;
  if (Array.isArray(events)) {
    for (const event of events) {
      if (!isRecord(event)) continue;
      if (event.type !== 'finish' && event.type !== 'step-finish') continue;
      if (isRecord(event.usage)) usage = event.usage;
    }
  }
  const inputTokens: number = numberOr(usage?.inputTokens, 0);
  const outputTokens: number = numberOr(usage?.outputTokens, 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: numberOr(usage?.totalTokens, inputTokens + outputTokens),
  };
}

function toOpenAiUsage(usage: NormalizedUsage): OpenAiUsage {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

/** Read tool calls from a structural `LLMResponse`. */
function responseToolCalls(value: unknown): Array<OpencodeToolCall> {
  if (!Array.isArray(value)) return [];
  const calls: Array<OpencodeToolCall> = [];
  for (const call of value) {
    if (!isRecord(call)) continue;
    if (typeof call.id !== "string" || typeof call.name !== "string") continue;
    calls.push({ id: call.id, name: call.name, input: call.input });
  }
  return calls;
}

/** Map `finish.reason.normalized` to the OpenAI `finish_reason` enum. */
function finishReason(reason: unknown): "stop" | "length" | "tool_calls" {
  const normalized: unknown = isRecord(reason) ? reason.normalized : undefined;
  if (normalized === "tool-calls") return "tool_calls";
  if (normalized === "length") return "length";
  return "stop";
}

/** Read the normalized `_tag` of an Effect/AI tagged error (incl. AI.Error). */
function errorTag(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const direct: unknown = error._tag;
  if (typeof direct === "string" && direct !== "AI.Error") return direct;
  if (isRecord(error.reason) && typeof error.reason._tag === "string") {
    return error.reason._tag;
  }
  return typeof direct === "string" ? direct : undefined;
}

/**
 * HTTP status for an `AIError` (Effect tagged error): the tag is normalized
 * by dropping the `Error` suffix (`AuthenticationError` → `Authentication`).
 * Unknown shapes fall back to 502 (never leak upstream text).
 */
function statusForError(error: unknown): number {
  const tag: string | undefined = errorTag(error);
  const name: string | undefined = tag?.endsWith("Error")
    ? tag.slice(0, -"Error".length)
    : tag;
  switch (name) {
    case "Authentication":
      return 401;
    case "RateLimit":
    case "QuotaExceeded":
      return 429;
    case "InvalidRequest":
    case "ContentPolicy":
      return 400;
    case "Timeout":
      return 504;
    case "NoRoute":
    case "ProviderConfiguration":
      return 503;
    case "ProviderInternal":
    case "InvalidProviderOutput":
    case "UnknownProvider":
    case "UnsupportedOperation":
    case "Transport":
      return 502;
    default:
      return 502;
  }
}

/** Extract the safe code/message of a 404 `NotFoundException` (no secrets). */
function keyMissingResponse(error: NotFoundException): Response {
  const raw: string | object = error.getResponse();
  const body: Record<string, unknown> = isRecord(raw) ? raw : {};
  return jsonResponse(
    {
      error: {
        code: typeof body.code === "string" ? body.code : "opencode_key_missing",
        message:
          typeof body.message === "string"
            ? body.message
            : "No OpenCode API key configured for this user",
      },
    },
    404,
  );
}

/** Default LanguageModel builder: openai-compatible route with a per-call key. */
async function buildDefaultModel(modelId: string, apiKey: string): Promise<unknown> {
  const openAiCompatible: {
    model: (id: string, settings: Record<string, unknown>) => unknown;
  } = (await import("@opencode/ai/providers/openai-compatible")) as unknown as {
    model: (id: string, settings: Record<string, unknown>) => unknown;
  };
  return openAiCompatible.model(modelId, {
    apiKey,
    baseURL: OPENCODE_CHAT_BASE_URL,
    provider: OPENCODE_UPSTREAM_PROVIDER,
  });
}

/** Default runtime factory: the promise-first `@opencode/ai` `make()`. */
async function createDefaultRuntime(): Promise<OpencodeRuntime> {
  const aiModule: { make: () => OpencodeRuntime } = (await import(
    "@opencode/ai"
  )) as unknown as {
    make: () => OpencodeRuntime;
  };
  return aiModule.make();
}

/** SSE frame helpers (one `data:` line per frame). */
function sseFrame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseDone(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

/**
 * Async-iterable SSE body: text deltas, tool calls, the terminal finish
 * chunk (with usage) and `[DONE]`. A mid-stream failure writes ONE neutral
 * error frame, then `[DONE]`, then closes — never a silent truncation.
 */
async function* streamSse(
  events: AsyncIterable<unknown>,
  model: string,
  now: () => number,
  newId: () => string,
): AsyncGenerator<Uint8Array> {
  const id: string = newId();
  const created: number = now();
  let toolIndex: number = 0;
  let usage: NormalizedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const iterator: AsyncIterator<unknown> = events[Symbol.asyncIterator]();

  try {
    while (true) {
      const next: IteratorResult<unknown> = await iterator.next();
      if (next.done) break;
      const event: unknown = next.value;
      if (!isRecord(event)) continue;
      const typed: OpencodeStreamEvent = event as OpencodeStreamEvent;

      if (typed.type === "step-finish" && isRecord(typed.usage)) {
        usage = usageFromEvents([typed]);
        continue;
      }

      if (typed.type === "text-delta" && typeof typed.text === "string") {
        const chunk: OpenAiChatChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            { index: 0, delta: { content: typed.text }, finish_reason: null },
          ],
        };
        yield sseFrame(chunk);
        continue;
      }

      if (typed.type === "tool-call") {
        const callId: string = typeof typed.id === "string" ? typed.id : "";
        const name: string = typeof typed.name === "string" ? typed.name : "";
        const chunk: OpenAiChatChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: callId,
                    type: "function",
                    function: {
                      name,
                      arguments: JSON.stringify(typed.input ?? {}),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        toolIndex += 1;
        yield sseFrame(chunk);
        continue;
      }

      if (typed.type === "finish") {
        if (isRecord(typed.usage)) usage = usageFromEvents([typed]);
        const chunk: OpenAiChatChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            { index: 0, delta: {}, finish_reason: finishReason(typed.reason) },
          ],
          usage: toOpenAiUsage(usage),
        };
        yield sseFrame(chunk);
        break;
      }
    }
    yield sseDone();
  } catch {
    yield sseFrame(PROVIDER_ERROR_BODY);
    yield sseDone();
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // best-effort upstream cleanup
    }
  }
}

/**
 * Pure factory: returns a `fetch`-compatible function that serves one
 * OpenAI-compatible `POST /chat/completions` endpoint in process.
 */
export function createOpencodeFetch(deps: OpencodeModelFetchDeps): typeof fetch {
  const now: () => number = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const newId: () => string = deps.newId ?? (() => `chatcmpl-${randomUUID()}`);

  const adapter: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response> = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (!pathOf(inputUrl(input)).endsWith("/chat/completions")) {
      return notFound();
    }

    const rawBody: string | null = readBody(init?.body);
    if (rawBody === null) return badRequest("bad JSON body");

    let request: unknown;
    try {
      request = JSON.parse(rawBody);
    } catch {
      return badRequest("bad JSON body");
    }
    if (!isRecord(request)) return badRequest("bad JSON body");

    const chat: OpenAiChatRequest = request as unknown as OpenAiChatRequest;
    if (typeof chat.model !== "string" || chat.model.length === 0) {
      return badRequest("model is required");
    }
    if (!Array.isArray(chat.messages)) {
      return badRequest("messages must be an array");
    }

    let apiKey: string;
    try {
      apiKey = await deps.loadKey(OPENCODE_PROVIDER);
    } catch (error) {
      if (error instanceof NotFoundException) return keyMissingResponse(error);
      return jsonResponse(PROVIDER_ERROR_BODY, 502);
    }

    let languageModel: unknown;
    try {
      languageModel = deps.buildModel
        ? deps.buildModel(chat.model, apiKey)
        : await buildDefaultModel(chat.model, apiKey);
    } catch {
      return jsonResponse(PROVIDER_ERROR_BODY, 502);
    }

    const { system, messages }: { system?: string; messages: Array<LlmMessage> } =
      mapMessages(chat.messages);
    const generation: Record<string, number> | undefined = mapGeneration(chat);
    const requestInput: Record<string, unknown> = {
      model: languageModel,
      messages,
      tools: mapTools(chat.tools),
    };
    if (system !== undefined) requestInput.system = system;
    if (generation !== undefined) requestInput.generation = generation;

    const runtime: OpencodeRuntime = deps.makeClient
      ? deps.makeClient()
      : await createDefaultRuntime();

    if (chat.stream === true) {
      try {
        const events: AsyncIterable<unknown> = runtime.stream(
          requestInput,
          init?.signal ? { signal: init.signal } : undefined,
        );
        // The runtime is disposed only after the SSE body drains: disposing
        // before the lazy stream is consumed would kill the upstream call.
        const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const chunk of streamSse(events, chat.model, now, newId)) {
                controller.enqueue(chunk);
              }
            } finally {
              await runtime.dispose().catch(() => undefined);
              try {
                controller.close();
              } catch {
                // the downstream may already be cancelled
              }
            }
          },
        });
        return new Response(body as unknown as ResponseBody, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      } catch (error) {
        await runtime.dispose().catch(() => undefined);
        return jsonResponse(PROVIDER_ERROR_BODY, statusForError(error));
      }
    }

    try {
      const response: OpencodeGenerateResponse = (await runtime.generate(
        requestInput,
        init?.signal ? { signal: init.signal } : undefined,
      )) as OpencodeGenerateResponse;
      const text: string = typeof response.text === "string" ? response.text : "";
      const toolCalls: Array<OpencodeToolCall> = responseToolCalls(response.toolCalls);
      const usage: NormalizedUsage = usageFromEvents(response.events);
      const result: OpenAiChatResponse = {
        id: newId(),
        object: "chat.completion",
        created: now(),
        model: chat.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text.length > 0 ? text : null,
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input ?? {}),
                },
              })),
            },
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: toOpenAiUsage(usage),
      };
      return jsonResponse(result, 200);
    } catch (error) {
      return jsonResponse(PROVIDER_ERROR_BODY, statusForError(error));
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  };

  return adapter as typeof fetch;
}

/**
 * Nest-injectable adapter factory: binds the caller identity to the shared
 * per-user vault (`loadProviderKey` → VaultService + CryptoService). One fetch
 * per (user, call); the returned function is cheap.
 */
@Injectable()
export class OpencodeModelFetch {
  constructor(
    private readonly keys: VaultService,
    private readonly crypto: CryptoService,
  ) {}

  create(userId: string, providerId: string, correlationId?: string): typeof fetch {
    // `providerId` is part of the public contract (the chain owns the
    // provider id); the in-process transport is always `opencode`.
    void providerId;
    const keyDeps: ModelProviderKeyDeps = { keys: this.keys, crypto: this.crypto };
    return createOpencodeFetch({
      loadKey: (provider) =>
        loadProviderKey(keyDeps, userId, provider, correlationId),
    });
  }
}
