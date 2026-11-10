/**
 * Model chain router checks — self-contained runner (plain node:assert,
 * no network, no real timers, no LLM client).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/agents/__tests__/model-fallback.router.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers card C4: per-error-class decisions (retriable → one retry → next;
 * switch / bad_tool_call → next; tool_leak → provider excluded for the
 * request; fatal → original error; auth → EXTERNAL_UNAUTHORIZED fail-fast),
 * the client-unavailable switch, the empty/exhausted chain 503 and the fixed
 * `classifyModelError` table (code/name/status only, never message text).
 */
import assert from "node:assert/strict";
import { HttpException, NotFoundException } from "@nestjs/common";
import { ExternalServiceError } from "@common/external/external-error";
import {
  classifyModelError,
  type ModelErrorKind,
  type ModelRunnerDeps,
  runModelChain,
} from "../model-fallback";
import { MODEL_CHAIN, type ModelChainEntry } from "../model-provider";

/** Two opencode models and one openrouter model: the smallest two-provider chain. */
const CHAIN: ReadonlyArray<ModelChainEntry> = [
  {
    provider: "opencode",
    transport: "inprocess-opencode",
    model: "m1",
    jsonSchema: false,
  },
  {
    provider: "opencode",
    transport: "inprocess-opencode",
    model: "m2",
    jsonSchema: false,
  },
  {
    provider: "openrouter",
    transport: "http-openai",
    baseURL: "https://openrouter.ai/api/v1",
    model: "o1",
    jsonSchema: false,
  },
];

type CandidateRef = { provider: string; model: string };

/** One scripted `run` step: an answer or a thrown value. */
type Step = { answer: string } | { error: unknown };

/** Per-candidate script, keyed by `provider/model`, consumed call by call. */
type Script = Record<string, Array<Step>>;

type ScenarioOptions = {
  /** Defaults to the local two-provider `CHAIN`; `null` omits it. */
  chain?: ReadonlyArray<ModelChainEntry> | null;
  createClient?: (entry: ModelChainEntry) => Promise<unknown>;
};

type Scenario = {
  deps: ModelRunnerDeps<string>;
  runCalls: Array<CandidateRef>;
  clientCalls: Array<CandidateRef>;
  slept: Array<number>;
};

function candidateRef(entry: ModelChainEntry): CandidateRef {
  return { provider: entry.provider, model: entry.model };
}

/**
 * Builds router deps around a per-candidate script. `now` is deterministic
 * (0), `sleep` records instead of waiting, and an unexpected extra call on a
 * candidate fails the check instead of silently succeeding.
 */
function scenario(script: Script, options: ScenarioOptions = {}): Scenario {
  const runCalls: Array<CandidateRef> = [];
  const clientCalls: Array<CandidateRef> = [];
  const slept: Array<number> = [];
  const callCounts = new Map<string, number>();

  const defaultCreateClient = async (
    entry: ModelChainEntry,
  ): Promise<unknown> => {
    clientCalls.push(candidateRef(entry));
    return { provider: entry.provider, model: entry.model };
  };

  const run = async (
    _client: unknown,
    entry: ModelChainEntry,
  ): Promise<string> => {
    const key = `${entry.provider}/${entry.model}`;
    const index = callCounts.get(key) ?? 0;
    callCounts.set(key, index + 1);
    runCalls.push(candidateRef(entry));
    const step = (script[key] ?? [])[index];
    if (step === undefined) {
      throw new Error(`unexpected call #${index + 1} to ${key}`);
    }
    if ("answer" in step) return step.answer;
    throw step.error;
  };

  const deps: ModelRunnerDeps<string> = {
    ...(options.chain === null
      ? {}
      : { chain: options.chain ?? CHAIN }),
    createClient: options.createClient ?? defaultCreateClient,
    run,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => 0,
  };

  return { deps, runCalls, clientCalls, slept };
}

/** HTTP-status-shaped upstream error (message text is never used). */
function httpError(status: number): Error {
  return Object.assign(new Error(`upstream-${status}`), { status });
}

async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

function outcomes(meta: { attempts: Array<{ outcome: string }> }): Array<string> {
  return meta.attempts.map((attempt) => attempt.outcome);
}

function models(meta: { attempts: Array<{ model: string }> }): Array<string> {
  return meta.attempts.map((attempt) => attempt.model);
}

function assertUnavailable(err: unknown, attempt: number): void {
  assert.ok(
    err instanceof ExternalServiceError,
    "the exhausted chain must throw ExternalServiceError",
  );
  assert.equal(err.code, "EXTERNAL_UNAVAILABLE");
  assert.equal(err.httpStatus, 503);
  assert.equal(err.status, undefined);
  assert.equal(err.isRetryable, true);
  assert.equal(err.attempt, attempt);
}

type Check = { name: string; run: () => Promise<void> | void };

const checks: Array<Check> = [
  {
    name: "first candidate succeeds: provider/model meta, one ok attempt",
    run: async () => {
      const { deps, runCalls, slept } = scenario({
        "opencode/m1": [{ answer: "m1-answer" }],
      });
      const result = await runModelChain(deps);

      assert.equal(result.value, "m1-answer");
      assert.equal(result.meta.provider, "opencode");
      assert.equal(result.meta.model, "m1");
      assert.deepEqual(outcomes(result.meta), ["ok"]);
      assert.deepEqual(models(result.meta), ["m1"]);
      assert.equal(result.meta.attempts[0]?.attempt, 1);
      assert.equal(result.meta.attempts[0]?.reason, "ok");
      assert.equal(result.meta.attempts[0]?.latencyMs, 0);
      assert.equal(result.meta.fallback.attempts, 1);
      assert.equal("switchedFrom" in result.meta.fallback, false);
      assert.equal("reason" in result.meta.fallback, false);
      assert.deepEqual(runCalls, [{ provider: "opencode", model: "m1" }]);
      assert.deepEqual(slept, []);
    },
  },
  {
    name: "404 model → next model of the same provider, switchedFrom recorded",
    run: async () => {
      const { deps, slept } = scenario({
        "opencode/m1": [{ error: httpError(404) }],
        "opencode/m2": [{ answer: "m2-answer" }],
      });
      const result = await runModelChain(deps);

      assert.equal(result.value, "m2-answer");
      assert.equal(result.meta.provider, "opencode");
      assert.equal(result.meta.model, "m2");
      assert.deepEqual(outcomes(result.meta), ["switch", "ok"]);
      assert.deepEqual(models(result.meta), ["m1", "m2"]);
      assert.equal(result.meta.fallback.attempts, 2);
      assert.equal(result.meta.fallback.switchedFrom, "opencode");
      assert.equal(result.meta.fallback.reason, "not-found");
      assert.deepEqual(slept, [], "a 404 must not be retried");
    },
  },
  {
    name: "429 retries the same model once after 250ms, then succeeds",
    run: async () => {
      const { deps, slept } = scenario({
        "opencode/m1": [{ error: httpError(429) }, { answer: "m1-answer" }],
      });
      const result = await runModelChain(deps);

      assert.equal(result.value, "m1-answer");
      assert.equal(result.meta.provider, "opencode");
      assert.equal(result.meta.model, "m1");
      assert.deepEqual(outcomes(result.meta), ["retry", "ok"]);
      assert.deepEqual(
        result.meta.attempts.map((attempt) => attempt.attempt),
        [1, 2],
      );
      assert.deepEqual(slept, [250]);
      assert.equal(result.meta.fallback.attempts, 2);
      assert.equal("switchedFrom" in result.meta.fallback, false);
      assert.equal(result.meta.fallback.reason, "rate-limited");
    },
  },
  {
    name: "429 twice → next candidate (retry, retry, ok)",
    run: async () => {
      const { deps, slept } = scenario({
        "opencode/m1": [{ error: httpError(429) }, { error: httpError(429) }],
        "opencode/m2": [{ answer: "m2-answer" }],
      });
      const result = await runModelChain(deps);

      assert.equal(result.value, "m2-answer");
      assert.equal(result.meta.model, "m2");
      assert.deepEqual(outcomes(result.meta), ["retry", "retry", "ok"]);
      assert.deepEqual(models(result.meta), ["m1", "m1", "m2"]);
      assert.deepEqual(slept, [250]);
      assert.equal(result.meta.fallback.switchedFrom, "opencode");
      assert.equal(result.meta.fallback.reason, "rate-limited");
    },
  },
  {
    name: "400 → the original error is rethrown, one attempt, no next candidate",
    run: async () => {
      const fatal = httpError(400);
      const { deps, runCalls, slept } = scenario({
        "opencode/m1": [{ error: fatal }],
        "opencode/m2": [{ answer: "must-not-run" }],
      });
      const err = await captureThrow(() => runModelChain(deps));

      assert.equal(err, fatal, "a 400 must reach the client unchanged");
      assert.deepEqual(
        runCalls,
        [{ provider: "opencode", model: "m1" }],
        "exactly one attempt, the next candidate is never called",
      );
      assert.deepEqual(slept, []);
      // The single failed attempt is recorded as `fatal` (outcomeFor).
      assert.deepEqual(classifyModelError(err), {
        kind: "fatal",
        reason: "bad-request",
      });
    },
  },
  {
    name: "401 → EXTERNAL_UNAUTHORIZED fail-fast, next candidate never called",
    run: async () => {
      const unauthorized = httpError(401);
      const { deps, runCalls } = scenario({
        "opencode/m1": [{ error: unauthorized }],
        "opencode/m2": [{ answer: "must-not-run" }],
      });
      const err = await captureThrow(() => runModelChain(deps));

      assert.ok(err instanceof ExternalServiceError);
      assert.equal(err.code, "EXTERNAL_UNAUTHORIZED");
      assert.equal(err.httpStatus, 503);
      assert.equal(err.status, 401);
      assert.equal(err.isRetryable, false);
      assert.equal(err.attempt, 1);
      assert.equal(err.cause, unauthorized);
      assert.deepEqual(runCalls, [{ provider: "opencode", model: "m1" }]);
    },
  },
  {
    name: "bad_tool_call → next candidate",
    run: async () => {
      const { deps } = scenario({
        "opencode/m1": [{ error: { code: "bad_tool_call" } }],
        "opencode/m2": [{ answer: "m2-answer" }],
      });
      const result = await runModelChain(deps);

      assert.equal(result.value, "m2-answer");
      assert.deepEqual(outcomes(result.meta), ["bad-tool-call", "ok"]);
      assert.equal(result.meta.fallback.switchedFrom, "opencode");
      assert.equal(result.meta.fallback.reason, "bad-tool-call");
    },
  },
  {
    name: "PROVIDER_TOOL_LEAK excludes the whole provider for the request",
    run: async () => {
      const { deps, clientCalls } = scenario({
        "opencode/m1": [{ error: { code: "PROVIDER_TOOL_LEAK" } }],
        "openrouter/o1": [{ answer: "o1-answer" }],
      });
      const result = await runModelChain(deps);

      assert.equal(result.value, "o1-answer");
      assert.equal(result.meta.provider, "openrouter");
      assert.deepEqual(outcomes(result.meta), ["tool-leak", "ok"]);
      assert.deepEqual(models(result.meta), ["m1", "o1"]);
      assert.deepEqual(
        clientCalls.map((entry) => entry.model),
        ["m1", "o1"],
        "m2 (same provider) must be skipped without a client",
      );
      assert.equal(result.meta.fallback.switchedFrom, "opencode");
      assert.equal(result.meta.fallback.reason, "provider-tool-leak");
    },
  },
  {
    name: "createClient 404 (provider key missing) → switch to the next provider",
    run: async () => {
      const attempted: Array<string> = [];
      const createClient = async (
        entry: ModelChainEntry,
      ): Promise<unknown> => {
        attempted.push(`${entry.provider}/${entry.model}`);
        if (entry.provider === "opencode") {
          throw new NotFoundException({ code: "provider_key_missing" });
        }
        return { provider: entry.provider, model: entry.model };
      };
      const { deps, runCalls } = scenario(
        { "openrouter/o1": [{ answer: "o1-answer" }] },
        { createClient },
      );
      const result = await runModelChain(deps);

      assert.equal(result.value, "o1-answer");
      assert.equal(result.meta.provider, "openrouter");
      assert.deepEqual(attempted, [
        "opencode/m1",
        "opencode/m2",
        "openrouter/o1",
      ]);
      assert.deepEqual(runCalls, [{ provider: "openrouter", model: "o1" }]);
      assert.deepEqual(outcomes(result.meta), ["switch", "switch", "ok"]);
      assert.deepEqual(
        result.meta.attempts.map((attempt) => attempt.reason),
        ["client-unavailable", "client-unavailable", "ok"],
      );
      assert.equal(result.meta.fallback.switchedFrom, "opencode");
      assert.equal(result.meta.fallback.reason, "client-unavailable");
    },
  },
  {
    name: "createClient fail-fast key error is rethrown as-is",
    run: async () => {
      const failFast = new NotFoundException({ code: "opencode_key_missing" });
      const createClient = async (): Promise<unknown> => {
        throw failFast;
      };
      const { deps, runCalls } = scenario({}, { createClient });
      const err = await captureThrow(() => runModelChain(deps));

      assert.equal(err, failFast);
      assert.deepEqual(runCalls, []);
    },
  },
  {
    name: "empty chain → EXTERNAL_UNAVAILABLE attempt 0, no client created",
    run: async () => {
      const { deps, clientCalls } = scenario({}, { chain: [] });
      const err = await captureThrow(() => runModelChain(deps));

      assertUnavailable(err, 0);
      assert.deepEqual(clientCalls, []);
    },
  },
  {
    name: "exhausted chain (500 twice) → EXTERNAL_UNAVAILABLE with last cause",
    run: async () => {
      const first = httpError(500);
      const second = httpError(503);
      const { deps, slept } = scenario(
        { "opencode/m1": [{ error: first }, { error: second }] },
        { chain: CHAIN.slice(0, 1) },
      );
      const err = await captureThrow(() => runModelChain(deps));

      assertUnavailable(err, 2);
      assert.ok(err instanceof ExternalServiceError);
      assert.equal(err.cause, second);
      assert.deepEqual(slept, [250], "one retry before the chain is exhausted");
    },
  },
  {
    name: "deps.chain omitted → the in-code MODEL_CHAIN is the default",
    run: async () => {
      const firstEntry = MODEL_CHAIN[0];
      assert.ok(firstEntry, "the in-code chain must not be empty");
      const { deps } = scenario(
        {
          [`${firstEntry.provider}/${firstEntry.model}`]: [
            { answer: "default-chain-answer" },
          ],
        },
        { chain: null },
      );
      const result = await runModelChain(deps);

      assert.equal(result.value, "default-chain-answer");
      assert.equal(result.meta.provider, firstEntry.provider);
      assert.equal(result.meta.model, firstEntry.model);
      assert.equal(result.meta.fallback.attempts, 1);
    },
  },
];

type ClassifyCase = {
  name: string;
  error: unknown;
  kind: ModelErrorKind;
  reason?: string;
};

const CLASSIFY_CASES: Array<ClassifyCase> = [
  { name: "status 401 → auth", error: { status: 401 }, kind: "auth" },
  { name: "statusCode 403 → auth", error: { statusCode: 403 }, kind: "auth" },
  { name: "status 404 → switch", error: { status: 404 }, kind: "switch" },
  { name: "status 400 → fatal", error: { status: 400 }, kind: "fatal" },
  { name: "status 422 → fatal", error: { status: 422 }, kind: "fatal" },
  {
    name: "status 429 → retriable",
    error: { status: 429 },
    kind: "retriable",
    reason: "rate-limited",
  },
  {
    name: "status 500 → retriable",
    error: { status: 500 },
    kind: "retriable",
    reason: "server-error",
  },
  {
    name: "status 503 as string → retriable",
    error: { status: "503" },
    kind: "retriable",
  },
  {
    name: "cause.status 429 → retriable",
    error: { cause: { status: 429 } },
    kind: "retriable",
  },
  {
    name: "response.status 401 → auth",
    error: { response: { status: 401 } },
    kind: "auth",
  },
  {
    name: "name TimeoutError → retriable timeout",
    error: { name: "TimeoutError" },
    kind: "retriable",
    reason: "timeout",
  },
  {
    name: "name AbortError → retriable timeout",
    error: { name: "AbortError" },
    kind: "retriable",
    reason: "timeout",
  },
  {
    name: "code ETIMEDOUT → retriable timeout",
    error: { code: "ETIMEDOUT" },
    kind: "retriable",
    reason: "timeout",
  },
  ...["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].map(
    (code): ClassifyCase => ({
      name: `code ${code} → retriable network`,
      error: { code },
      kind: "retriable",
      reason: "network",
    }),
  ),
  {
    name: "unknown error → fatal unknown-error",
    error: new Error("boom"),
    kind: "fatal",
    reason: "unknown-error",
  },
  {
    name: "message text is never parsed (timeout/429/ECONNRESET words ignored)",
    error: new Error("timeout 429 ECONNRESET"),
    kind: "fatal",
    reason: "unknown-error",
  },
  {
    name: "code PROVIDER_TOOL_LEAK → tool_leak",
    error: { code: "PROVIDER_TOOL_LEAK" },
    kind: "tool_leak",
    reason: "provider-tool-leak",
  },
  {
    name: "name PROVIDER_TOOL_LEAK → tool_leak",
    error: { name: "PROVIDER_TOOL_LEAK" },
    kind: "tool_leak",
  },
  {
    name: "code bad_tool_call → bad_tool_call",
    error: { code: "bad_tool_call" },
    kind: "bad_tool_call",
    reason: "bad-tool-call",
  },
  {
    name: "name ToolCallValidationError → bad_tool_call",
    error: { name: "ToolCallValidationError" },
    kind: "bad_tool_call",
  },
  {
    name: "null throw → fatal unknown-error",
    error: null,
    kind: "fatal",
    reason: "unknown-error",
  },
  {
    name: "Nest HttpException 429 → retriable",
    error: new HttpException("slow down", 429),
    kind: "retriable",
  },
];

checks.push({
  name: "classifyModelError: fixed code/name/status table",
  run: () => {
    for (const testCase of CLASSIFY_CASES) {
      const classified = classifyModelError(testCase.error);
      assert.equal(
        classified.kind,
        testCase.kind,
        `${testCase.name}: expected kind ${testCase.kind}, got ${classified.kind}`,
      );
      if (testCase.reason !== undefined) {
        assert.equal(
          classified.reason,
          testCase.reason,
          `${testCase.name}: unexpected reason`,
        );
      }
    }
  },
});

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
    console.error(`${failed}/${checks.length} model router checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} model router checks failed`);
  }
  console.log(`${checks.length}/${checks.length} model router checks passed`);
}

void main().catch((error: unknown) => {
  console.error(
    `model router checks failed to run: ${(error as Error).message}`,
  );
  process.exit(1);
});
