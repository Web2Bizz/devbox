import { type ChatOpenAIFields, ChatOpenAI } from "@langchain/openai";
import type { ModelChainEntry } from "./model-provider";

/**
 * SCOPE: Processes → AI → Agents — single model client factory (card C2b).
 *
 * The agent layer always talks to exactly one class, `ChatOpenAI`, over the
 * OpenAI `POST /chat/completions` wire. Only the plumbing differs per
 * transport:
 * - `inprocess-opencode` — `configuration.fetch` is the in-process adapter from
 *   `OpencodeModelFetch.create(...)` (card C2): no HTTP hop, and the real
 *   per-user key is resolved inside the adapter for every call.
 * - `http-openai` — `configuration.baseURL` points at the OpenAI-compatible
 *   endpoint and the caller passes the resolved per-user provider key.
 *
 * Invariants:
 * - `useResponsesApi: false` is mandatory: the in-process adapter (and the
 *   agent contract) serves only `/chat/completions`; the Responses API would
 *   bypass it.
 * - Retries are 0 at both LangChain and SDK levels: `maxRetries: 0` reaches
 *   the base model's `AsyncCaller` (which would otherwise default to 6) and
 *   the OpenAI SDK client options (`configuration.maxRetries: 0`).
 *   Retry/fallback is the chain router's job (card C4), so one model attempt
 *   must never fan out into hidden retries.
 * - Nothing is executed here. The factory only wires a client; tools are
 *   merely declared on it (`bindTools`) and execution belongs to the LangChain
 *   tool wrapper layer (card C3), never to the provider.
 * - Keys stay per user: a plaintext key is never logged, persisted, defaulted
 *   to an env/server key or embedded into a URL.
 */

/** Extra wiring the in-process transport needs. */
export type ModelClientOptions = {
  /** In-process adapter (`createOpencodeFetch` / `OpencodeModelFetch.create`). */
  fetch?: typeof fetch;
};

/**
 * Placeholder key for the in-process transport. The real per-user key is
 * resolved inside the fetch adapter per call; the OpenAI SDK only requires a
 * non-empty string here. It is never logged and never reaches the network.
 */
const INPROCESS_PLACEHOLDER_KEY: string = "in-process-adapter";

/**
 * `maxRetries` is not declared on `ChatOpenAIFields` in `@langchain/openai`
 * 1.8.2, but the base model forwards every field to the LangChain
 * `AsyncCaller` (its default is 6 retries), so it is typed explicitly here.
 */
type RetryFreeChatOpenAIFields = ChatOpenAIFields & { maxRetries: number };

/**
 * Places the retry budget at 0 on the model fields (LangChain `AsyncCaller`)
 * and on the OpenAI SDK client options together: one attempt per call.
 */
function retryFreeFields(fields: ChatOpenAIFields): RetryFreeChatOpenAIFields {
  return { ...fields, maxRetries: 0 };
}

/**
 * Builds the one `ChatOpenAI` client for a chain candidate.
 *
 * @param entry Resolved chain candidate (transport + provider endpoint + model).
 * @param apiKey Per-user plaintext key (validated non-empty; trimmed).
 * @param options Transport extras (`fetch` adapter for `inprocess-opencode`).
 * @throws Error when the key is blank, `baseURL` is missing for `http-openai`,
 * the fetch adapter is missing for `inprocess-opencode`, or the transport is
 * not one this factory serves.
 */
export function createModelClient(
  entry: ModelChainEntry,
  apiKey: string,
  options: ModelClientOptions = {},
): ChatOpenAI {
  const key: string = apiKey.trim();
  if (key.length === 0) {
    throw new Error("apiKey is required for a model client");
  }

  switch (entry.transport) {
    case "http-openai": {
      const baseURL: string | undefined = entry.baseURL;
      if (baseURL === undefined || baseURL.trim().length === 0) {
        throw new Error("http-openai provider requires baseURL");
      }
      return new ChatOpenAI(
        retryFreeFields({
          model: entry.model,
          apiKey: key,
          useResponsesApi: false,
          configuration: { baseURL, maxRetries: 0 },
        }),
      );
    }
    case "inprocess-opencode": {
      const fetchAdapter: typeof fetch | undefined = options.fetch;
      if (!fetchAdapter) {
        throw new Error("in-process transport requires a fetch adapter");
      }
      return new ChatOpenAI(
        retryFreeFields({
          model: entry.model,
          // Placeholder only: the adapter resolves the real per-user key.
          apiKey: INPROCESS_PLACEHOLDER_KEY,
          useResponsesApi: false,
          configuration: { fetch: fetchAdapter, maxRetries: 0 },
        }),
      );
    }
    default:
      throw new Error(
        `Unsupported model transport '${String(entry.transport)}'`,
      );
  }
}
