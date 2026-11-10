import { HumanMessage, type MessageContent, SystemMessage } from '@langchain/core/messages';
import type { ChatOpenAI } from '@langchain/openai';
import { HttpException } from '@nestjs/common';
import type { CryptoService } from '@common/crypto/crypto.service';
import { ExternalServiceError } from '@common/external/external-error';
import type { VaultService } from '@common/vault/vault.service';
import type { ModelChainEntry } from './model-provider';

/**
 * Shared ask fallback chain (user-ordered paid openai-compatible ids; the
 * runner default CLOUD_DEFAULT_MODEL is untouched and the runner is not
 * modified). First success wins; ask() signatures take no model from outside.
 *
 * Fail-fast rule (no iteration, rethrown as-is): 404 opencode_key_missing
 * and 401 opencode_key_invalid — the code/key pair is identical for every
 * model. Detected by HttpException status/code, never by message text.
 */
export const ASK_FALLBACK_MODELS: ReadonlyArray<string> = [
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'qwen3.8-max',
  'glm-5.3-flash',
];

/** Fail-fast signal: key state is model-independent, retrying cannot help. */
export function isFailFastKeyError(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const status: number = error.getStatus();
  const response: unknown = error.getResponse();
  const code: unknown =
    typeof response === 'object' && response !== null
      ? (response as { code?: unknown }).code
      : undefined;
  return (
    (status === 404 && code === 'opencode_key_missing') ||
    (status === 401 && code === 'opencode_key_invalid')
  );
}

/**
 * SCOPE: Processes → AI → Agents — model chain router (card C4).
 *
 * Walks `MODEL_CHAIN` in order and decides per failure class (plan §4, Q5):
 * - `retriable` (429 / 5xx / timeout / network) — one retry on the same
 *   candidate, then the next candidate.
 * - `switch` (404 model) / `bad_tool_call` — the next candidate at once.
 * - `tool_leak` (`PROVIDER_TOOL_LEAK`) — the whole provider is excluded from
 *   this request, the next candidate runs.
 * - `fatal` (400/422 and unknown errors) — the ORIGINAL error is rethrown, no
 *   wrapping: an invalid request must reach the client as-is and an unknown
 *   error must not be masked as a provider switch.
 * - `auth` (401/403) — fail-fast `EXTERNAL_UNAUTHORIZED` (503 on the wire),
 *   the chain never continues: the same credentials would fail the same way.
 * - `probe` (card C9) — an injected provider liveness check runs once per
 *   provider before its first model call; a `false`/throwing probe records a
 *   `probe` attempt (`probe-down` / `probe-error`) and walks to the next
 *   candidate without creating a client. No probe dep → C4 behaviour.
 *
 * Exhaustion (or an empty chain) → `EXTERNAL_UNAVAILABLE` 503 with
 * `isRetryable: true`; `ApiErrorFilter` adds `Retry-After: 30` and
 * `x-correlation-id`. `reason` strings are fixed literals: no keys, URLs or
 * upstream bodies ever reach the audit or the error.
 */

/** One per-candidate attempt outcome recorded for the audit (card C8). */
export type ModelAttemptOutcome =
  | 'ok'
  | 'retry'
  | 'switch'
  | 'fatal'
  | 'auth'
  | 'tool-leak'
  | 'bad-tool-call'
  /** Provider liveness/readiness probe failed: the model was never called (C9). */
  | 'probe';

/** One attempt: who, which try, what happened, how long it took. */
export type ModelAttempt = {
  provider: string;
  model: string;
  /** 1-based attempt number inside the candidate (max 2). */
  attempt: number;
  outcome: ModelAttemptOutcome;
  /** Fixed reason literal (`rate-limited`, `not-found`, ...), never a secret. */
  reason: string;
  latencyMs: number;
};

/** Metadata of a successful chain run (additive `done` payload, card C8). */
export type ModelRunMeta = {
  provider: string;
  model: string;
  attempts: Array<ModelAttempt>;
  fallback: {
    attempts: number;
    /** Provider of the first candidate the chain walked away from. */
    switchedFrom?: string;
    /** Reason of the last failed attempt, when there was one. */
    reason?: string;
  };
};

/** Value + the metadata the caller reports on `done`. */
export type ModelRunResult<T> = { value: T; meta: ModelRunMeta };

/** Failure classes the router acts on. */
export type ModelErrorKind =
  | 'retriable'
  | 'switch'
  | 'fatal'
  | 'auth'
  | 'bad_tool_call'
  | 'tool_leak';

/** Dependencies of `runModelChain` (an injected client factory + run step). */
export type ModelRunnerDeps<T> = {
  /** Chain to walk; defaults to the in-code `MODEL_CHAIN`. */
  chain?: ReadonlyArray<ModelChainEntry>;
  /** ChatOpenAI-compatible client for one candidate (any object in tests). */
  createClient: (entry: ModelChainEntry) => Promise<unknown>;
  /** One model call on the created client (a step of the agent turn). */
  run: (client: unknown, entry: ModelChainEntry) => Promise<T>;
  /**
   * Provider liveness/readiness check (card C9), called BEFORE the first
   * client creation/model call of a provider in this request. `true` — the
   * provider is alive, `false`/throw — the whole provider is skipped for this
   * request. At most one call per provider id (memoized); omitting it keeps
   * the C4 behaviour unchanged.
   */
  probe?: (entry: ModelChainEntry) => Promise<boolean>;
  /** Retry delay; overridden in tests to avoid real timers. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Clock for `latencyMs`; overridden in tests for determinism. */
  now?: () => number;
  /** Correlation id kept for the audit/log layers. */
  correlationId?: string;
};

/** Max attempts per candidate: one retry, then switch (plan §4). */
const MAX_ATTEMPTS: number = 2;

/** Fixed retry delay for a `retriable` failure (one retry on the same model). */
const RETRY_DELAY_MS: number = 250;

const FIXED_UNAVAILABLE_MESSAGE: string = 'сервис временно недоступен, повторите позже';
const FIXED_UNAUTHORIZED_MESSAGE: string =
  'внутренняя авторизация в вышестоящем сервисе не пройдена';

/** Timeout/abort names and codes; message text is never inspected. */
const TIMEOUT_NAMES: ReadonlySet<string> = new Set(['TimeoutError', 'AbortError']);
const TIMEOUT_CODES: ReadonlySet<string> = new Set(['TimeoutError', 'AbortError', 'ETIMEDOUT']);

/** Plain network error codes (worth one retry, never a fatal stop). */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value: unknown = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Numeric HTTP status from a value (`number` or numeric string), else undefined. */
function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed: number = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * HTTP status carried by an error, in priority order:
 * `status` → `statusCode` → Nest `getStatus()` → `cause.status` →
 * `response.status`. Shape only, never message text.
 */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record: Record<string, unknown> = error as Record<string, unknown>;

  const direct: number | undefined = numericStatus(record['status']);
  if (direct !== undefined) return direct;

  const statusCode: number | undefined = numericStatus(record['statusCode']);
  if (statusCode !== undefined) return statusCode;

  if (typeof record['getStatus'] === 'function') {
    try {
      const fromException: number | undefined = numericStatus(
        (record['getStatus'] as () => unknown)(),
      );
      if (fromException !== undefined) return fromException;
    } catch {
      // A broken getStatus() must not mask the error classification.
    }
  }

  const cause: unknown = record['cause'];
  if (typeof cause === 'object' && cause !== null) {
    const fromCause: number | undefined = numericStatus((cause as Record<string, unknown>)['status']);
    if (fromCause !== undefined) return fromCause;
  }

  const response: unknown = record['response'];
  if (typeof response === 'object' && response !== null) {
    const fromResponse: number | undefined = numericStatus(
      (response as Record<string, unknown>)['status'],
    );
    if (fromResponse !== undefined) return fromResponse;
  }

  return undefined;
}

/**
 * Classifies an unknown throw into the router's failure classes.
 *
 * Only `code`, `name` and HTTP status are read — never the message text, so a
 * scary string can not change the decision. Unknown errors are `fatal`
 * (`unknown-error`): a bug must not be masked as a provider switch.
 */
export function classifyModelError(error: unknown): {
  kind: ModelErrorKind;
  reason: string;
} {
  if (typeof error !== 'object' || error === null) {
    return { kind: 'fatal', reason: 'unknown-error' };
  }
  const record: Record<string, unknown> = error as Record<string, unknown>;
  const code: string | undefined = readString(record, 'code');
  const name: string | undefined = readString(record, 'name');

  if (code === 'PROVIDER_TOOL_LEAK' || name === 'PROVIDER_TOOL_LEAK') {
    return { kind: 'tool_leak', reason: 'provider-tool-leak' };
  }
  if (code === 'bad_tool_call' || name === 'ToolCallValidationError') {
    return { kind: 'bad_tool_call', reason: 'bad-tool-call' };
  }

  const status: number | undefined = statusOf(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return { kind: 'auth', reason: 'unauthorized' };
    }
    if (status === 404) return { kind: 'switch', reason: 'not-found' };
    if (status === 400 || status === 422) {
      return { kind: 'fatal', reason: 'bad-request' };
    }
    if (status === 429) return { kind: 'retriable', reason: 'rate-limited' };
    if (status >= 500 && status <= 599) {
      return { kind: 'retriable', reason: 'server-error' };
    }
  }

  if (
    (name !== undefined && TIMEOUT_NAMES.has(name)) ||
    (code !== undefined && TIMEOUT_CODES.has(code))
  ) {
    return { kind: 'retriable', reason: 'timeout' };
  }
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return { kind: 'retriable', reason: 'network' };
  }

  return { kind: 'fatal', reason: 'unknown-error' };
}

/** Audit outcome for a failure class. */
function outcomeFor(kind: ModelErrorKind): ModelAttemptOutcome {
  switch (kind) {
    case 'retriable':
      return 'retry';
    case 'switch':
      return 'switch';
    case 'fatal':
      return 'fatal';
    case 'auth':
      return 'auth';
    case 'bad_tool_call':
      return 'bad-tool-call';
    case 'tool_leak':
      return 'tool-leak';
  }
}

/**
 * Walks the chain until one candidate succeeds or the chain is exhausted.
 *
 * `createClient` failures are `switch` (`client-unavailable`) unless they are
 * the model-independent fail-fast key errors (`isFailFastKeyError`), which are
 * rethrown as-is. A `retriable` failure retries the same candidate once after
 * `sleep(250)`; everything else is decided per class (see the module comment).
 *
 * When `deps.probe` is supplied it runs once per provider id (memoized) BEFORE
 * `createClient`: a dead/throwing provider is recorded as a `probe` attempt and
 * skipped for the rest of the request, so no client is created for it and the
 * probe error never escapes (no secret in `reason`).
 *
 * @throws ExternalServiceError EXTERNAL_UNAUTHORIZED on the first `auth`.
 * @throws the original error on `fatal` (400/422/unknown), never wrapped.
 * @throws ExternalServiceError EXTERNAL_UNAVAILABLE when the chain is empty or
 * exhausted (503 + Retry-After 30 at the HTTP filter).
 */
export async function runModelChain<T>(
  deps: ModelRunnerDeps<T>,
): Promise<ModelRunResult<T>> {
  // `model-provider` already imports `ASK_FALLBACK_MODELS`/`isFailFastKeyError`
  // from this module, so the default chain is resolved lazily: a top-level
  // import here would create a load-order cycle when this module is evaluated
  // first.
  const chain: ReadonlyArray<ModelChainEntry> =
    deps.chain ?? (await import('./model-provider')).MODEL_CHAIN;
  const sleep: (milliseconds: number) => Promise<void> =
    deps.sleep ?? defaultSleep;
  const now: () => number = deps.now ?? Date.now;

  const attempts: Array<ModelAttempt> = [];
  const excludedProviders: Set<string> = new Set<string>();
  /**
   * Probe memo per provider id (card C9): `true` — alive, `false` — reported
   * down, `null` — the probe threw. Every model of the provider reuses it, so
   * a provider is probed at most once per request.
   */
  const probeResults: Map<string, boolean | null> = new Map<string, boolean | null>();
  let switchedFrom: string | undefined;
  let lastReason: string | undefined;
  let lastError: unknown;

  if (chain.length === 0) {
    throw new ExternalServiceError({
      code: 'EXTERNAL_UNAVAILABLE',
      service: 'models',
      operation: 'chat',
      message: FIXED_UNAVAILABLE_MESSAGE,
      attempt: 0,
      isRetryable: true,
    });
  }

  for (const entry of chain) {
    if (excludedProviders.has(entry.provider)) continue;

    if (deps.probe) {
      const probeStartedAt: number = now();
      let alive: boolean | null;
      if (probeResults.has(entry.provider)) {
        alive = probeResults.get(entry.provider) ?? null;
      } else {
        try {
          alive = (await deps.probe(entry)) === true;
        } catch {
          // A probe failure only excludes the provider: the error is never
          // rethrown and never lands in `reason` (no secrets/upstream text).
          alive = null;
        }
        probeResults.set(entry.provider, alive);
      }
      if (alive !== true) {
        const reason: string = alive === null ? 'probe-error' : 'probe-down';
        attempts.push({
          provider: entry.provider,
          model: entry.model,
          attempt: 1,
          outcome: 'probe',
          reason,
          latencyMs: Math.max(0, now() - probeStartedAt),
        });
        switchedFrom ??= entry.provider;
        lastReason = reason;
        continue;
      }
    }

    const clientStartedAt: number = now();
    let client: unknown;
    try {
      client = await deps.createClient(entry);
    } catch (error) {
      if (isFailFastKeyError(error)) {
        // Fail-fast: the key state is model-independent (rethrow as-is).
        throw error;
      }
      const latencyMs: number = Math.max(0, now() - clientStartedAt);
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        attempt: 1,
        outcome: 'switch',
        reason: 'client-unavailable',
        latencyMs,
      });
      switchedFrom ??= entry.provider;
      lastReason = 'client-unavailable';
      lastError = error;
      continue;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const startedAt: number = now();
      try {
        const value: T = await deps.run(client, entry);
        attempts.push({
          provider: entry.provider,
          model: entry.model,
          attempt,
          outcome: 'ok',
          reason: 'ok',
          latencyMs: Math.max(0, now() - startedAt),
        });
        return {
          value,
          meta: {
            provider: entry.provider,
            model: entry.model,
            attempts,
            fallback: {
              attempts: attempts.length,
              ...(switchedFrom !== undefined ? { switchedFrom } : {}),
              ...(lastReason !== undefined ? { reason: lastReason } : {}),
            },
          },
        };
      } catch (error) {
        const classified: ReturnType<typeof classifyModelError> = classifyModelError(error);
        attempts.push({
          provider: entry.provider,
          model: entry.model,
          attempt,
          outcome: outcomeFor(classified.kind),
          reason: classified.reason,
          latencyMs: Math.max(0, now() - startedAt),
        });
        lastError = error;
        lastReason = classified.reason;

        if (classified.kind === 'auth') {
          const status: number | undefined = statusOf(error);
          throw new ExternalServiceError({
            code: 'EXTERNAL_UNAUTHORIZED',
            service: 'models',
            operation: 'chat',
            message: FIXED_UNAUTHORIZED_MESSAGE,
            ...(status !== undefined ? { status } : {}),
            attempt,
            isRetryable: false,
            cause: error,
          });
        }
        if (classified.kind === 'fatal') {
          // 400/422 must reach the client unchanged; an unknown error is a bug
          // and must not be masked as a provider switch.
          throw error;
        }
        if (classified.kind === 'retriable' && attempt === 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        if (classified.kind === 'tool_leak') {
          // The whole provider is dropped for this request: every model of it
          // would produce the same leak.
          excludedProviders.add(entry.provider);
        }
        // switch / bad_tool_call / second retriable / tool_leak → next candidate.
        switchedFrom ??= entry.provider;
        break;
      }
    }
  }

  throw new ExternalServiceError({
    code: 'EXTERNAL_UNAVAILABLE',
    service: 'models',
    operation: 'chat',
    message: FIXED_UNAVAILABLE_MESSAGE,
    attempt: attempts.length,
    isRetryable: true,
    ...(lastError !== undefined ? { cause: lastError } : {}),
  });
}

/**
 * Dependencies of `completeText` (card C5): one plain-text completion through
 * the model chain router, with the caller's per-user keys.
 */
export type TextCompletionDeps = {
  /** Caller owning the provider key. */
  userId: string;
  /** User prompt (human role). */
  prompt: string;
  /** Optional domain system prompt (system role); omitted for AskAgent. */
  system?: string;
  /** Correlation id kept for logs/audit. */
  correlationId?: string;
  /** Shared per-consumer vault (ciphertext store + round-robin picks). */
  keys: VaultService;
  /** Existing KEK envelope (decrypt in memory only). */
  crypto: CryptoService;
  /** In-process `fetch` adapter factory for `inprocess-opencode`. */
  inprocessFetch: (
    userId: string,
    providerId: string,
    correlationId?: string,
  ) => typeof fetch;
  /** Chain to walk; defaults to the in-code `MODEL_CHAIN`. */
  chain?: ReadonlyArray<ModelChainEntry>;
};

/**
 * Runs one plain-text completion through `runModelChain`.
 *
 * Every candidate gets its own client: the per-user provider key is loaded
 * lazily inside `createClient` (`loadProviderKey`), so the fail-fast 404
 * `opencode_key_missing` is rethrown by the router untouched — no key fallback
 * to another user/provider. The `inprocess-opencode` transport wires the
 * in-process fetch adapter; `http-openai` uses the resolved key directly.
 *
 * @throws the fail-fast key errors as-is (404 `opencode_key_missing`, 401).
 * @throws per the router classification (`EXTERNAL_UNAUTHORIZED`,
 * `EXTERNAL_UNAVAILABLE`, or the original fatal error).
 */
export async function completeText(
  deps: TextCompletionDeps,
): Promise<ModelRunResult<string>> {
  const correlationId: string | undefined = deps.correlationId;
  return runModelChain({
    chain: deps.chain,
    correlationId,
    createClient: async (entry) => {
      // Lazy imports: `model-provider` imports this module, so a top-level
      // import would strengthen the existing load-order cycle.
      // type: destructuring — the tuple comes from `Promise.all` of dynamic
      // imports; the explicit syntax cannot restate a two-module destructure.
      const [{ createModelClient }, { loadProviderKey }] = await Promise.all([
        import('./model-client'),
        import('./model-provider'),
      ]);
      const key: string = await loadProviderKey(
        { keys: deps.keys, crypto: deps.crypto },
        deps.userId,
        entry.provider,
        correlationId,
      );
      const fetchAdapter: typeof fetch | undefined =
        entry.transport === 'inprocess-opencode'
          ? deps.inprocessFetch(deps.userId, entry.provider, correlationId)
          : undefined;
      return createModelClient(
        entry,
        key,
        fetchAdapter ? { fetch: fetchAdapter } : {},
      );
    },
    run: async (client) => {
      const messages: Array<SystemMessage | HumanMessage> = [
        ...(deps.system !== undefined
          ? [new SystemMessage(deps.system)]
          : []),
        new HumanMessage(deps.prompt),
      ];
      const response: Awaited<ReturnType<ChatOpenAI['invoke']>> = await (
        client as ChatOpenAI
      ).invoke(messages);
      const content: MessageContent = response.content;
      return typeof content === 'string'
        ? content
        : content
            .map((part) =>
              typeof part === 'string'
                ? part
                : (part as { type?: string; text?: string }).type === 'text'
                  ? String((part as { text?: unknown }).text ?? '')
                  : '',
            )
            .join('');
    },
  });
}
