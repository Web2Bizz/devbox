/**
 * Provider probe checks for the model chain router — self-contained runner
 * (plain node:assert, no network, no real timers, no LLM client).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/agents/__tests__/model-fallback.probe.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers card C9: the optional `probe` dependency runs at most once per
 * provider per request (memoized), a dead/throwing provider is recorded as a
 * `probe` attempt without creating a client and without leaking the error, and
 * an all-probe-down chain still ends as EXTERNAL_UNAVAILABLE (503, retryable).
 * Without `probe` the C4 behaviour is unchanged.
 */
import assert from "node:assert/strict";
import { ExternalServiceError } from "@common/external/external-error";
import {
  type ModelRunnerDeps,
  runModelChain,
} from "../model-fallback";
import type { ModelChainEntry } from "../model-provider";

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
  /** Defaults to the local two-provider `CHAIN`. */
  chain?: ReadonlyArray<ModelChainEntry>;
  createClient?: (entry: ModelChainEntry) => Promise<unknown>;
  /** Card C9 liveness check; omitted by default (plain C4 behaviour). */
  probe?: (entry: ModelChainEntry) => Promise<boolean>;
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
    chain: options.chain ?? CHAIN,
    createClient: options.createClient ?? defaultCreateClient,
    run,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => 0,
    ...(options.probe !== undefined ? { probe: options.probe } : {}),
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
  assert.equal(err.isRetryable, true);
  assert.equal(
    err.message,
    "сервис временно недоступен, повторите позже",
    "the 503 message must stay fixed",
  );
  assert.equal(err.attempt, attempt);
}

type Check = { name: string; run: () => Promise<void> | void };

const checks: Array<Check> = [
  {
    name: "probe false for opencode → model not called, success on openrouter",
    run: async () => {
      const probeCalls: Array<string> = [];
      const { deps, runCalls, clientCalls } = scenario(
        { "openrouter/o1": [{ answer: "o1-answer" }] },
        {
          probe: async (entry) => {
            probeCalls.push(entry.provider);
            return entry.provider !== "opencode";
          },
        },
      );
      const result = await runModelChain(deps);

      assert.equal(result.value, "o1-answer");
      assert.equal(result.meta.provider, "openrouter");
      assert.equal(result.meta.model, "o1");
      assert.equal(result.meta.attempts[0]?.outcome, "probe");
      assert.equal(result.meta.attempts[0]?.reason, "probe-down");
      assert.equal(result.meta.attempts[0]?.attempt, 1);
      assert.equal(result.meta.attempts[0]?.latencyMs, 0);
      assert.equal(result.meta.fallback.switchedFrom, "opencode");
      assert.equal(result.meta.fallback.reason, "probe-down");
      assert.deepEqual(
        runCalls,
        [{ provider: "openrouter", model: "o1" }],
        "opencode models must never run",
      );
      assert.deepEqual(clientCalls, [{ provider: "openrouter", model: "o1" }]);
      assert.deepEqual(
        probeCalls,
        ["opencode", "openrouter"],
        "one probe per provider, memoized for the second opencode model",
      );
      assert.deepEqual(outcomes(result.meta), ["probe", "probe", "ok"]);
      assert.deepEqual(models(result.meta), ["m1", "m2", "o1"]);
    },
  },
  {
    name: "throwing probe → probe-error attempt, error never leaks, next provider",
    run: async () => {
      const probeError = new Error("upstream secret-shaped detail");
      const { deps, runCalls } = scenario(
        { "openrouter/o1": [{ answer: "o1-answer" }] },
        {
          probe: async (entry) => {
            if (entry.provider === "opencode") throw probeError;
            return true;
          },
        },
      );
      const result = await runModelChain(deps);

      assert.equal(result.value, "o1-answer");
      assert.equal(result.meta.provider, "openrouter");
      assert.deepEqual(outcomes(result.meta), ["probe", "probe", "ok"]);
      for (const attempt of result.meta.attempts.slice(0, 2)) {
        assert.equal(attempt.outcome, "probe");
        assert.equal(attempt.reason, "probe-error");
      }
      assert.equal(result.meta.fallback.switchedFrom, "opencode");
      assert.equal(result.meta.fallback.reason, "probe-error");
      assert.deepEqual(runCalls, [{ provider: "openrouter", model: "o1" }]);
      for (const attempt of result.meta.attempts) {
        assert.equal(
          attempt.reason.includes(probeError.message),
          false,
          "the probe error message must not leak into the audit",
        );
      }
    },
  },
  {
    name: "probe runs once per provider: 404 on the first model, no re-probe",
    run: async () => {
      const probeCalls: Array<string> = [];
      const { deps } = scenario(
        {
          "opencode/m1": [{ error: httpError(404) }],
          "opencode/m2": [{ answer: "m2-answer" }],
        },
        {
          probe: async (entry) => {
            probeCalls.push(`${entry.provider}/${entry.model}`);
            return true;
          },
        },
      );
      const result = await runModelChain(deps);

      assert.equal(result.value, "m2-answer");
      assert.equal(result.meta.model, "m2");
      assert.deepEqual(outcomes(result.meta), ["switch", "ok"]);
      assert.deepEqual(
        probeCalls,
        ["opencode/m1"],
        "the second opencode model reuses the memoized probe result",
      );
    },
  },
  {
    name: "probe is not repeated when the same candidate is retried (429)",
    run: async () => {
      const probeCalls: Array<string> = [];
      const { deps, slept } = scenario(
        {
          "opencode/m1": [{ error: httpError(429) }, { answer: "m1-answer" }],
        },
        {
          probe: async (entry) => {
            probeCalls.push(`${entry.provider}/${entry.model}`);
            return true;
          },
        },
      );
      const result = await runModelChain(deps);

      assert.equal(result.value, "m1-answer");
      assert.deepEqual(outcomes(result.meta), ["retry", "ok"]);
      assert.deepEqual(slept, [250]);
      assert.deepEqual(probeCalls, ["opencode/m1"]);
    },
  },
  {
    name: "all providers probe-down → EXTERNAL_UNAVAILABLE, attempt = probes",
    run: async () => {
      const { deps, runCalls, clientCalls } = scenario(
        {},
        { probe: async () => false },
      );
      const err = await captureThrow(() => runModelChain(deps));

      assertUnavailable(err, CHAIN.length);
      assert.deepEqual(runCalls, [], "no model is ever called");
      assert.deepEqual(
        clientCalls,
        [],
        "no client is created for a probe-down provider",
      );
    },
  },
  {
    name: "no probe dep → C4 behaviour unchanged, no probe attempts",
    run: async () => {
      const { deps, runCalls } = scenario({
        "opencode/m1": [{ answer: "m1-answer" }],
      });
      const result = await runModelChain(deps);

      assert.equal(result.value, "m1-answer");
      assert.equal(result.meta.provider, "opencode");
      assert.equal(result.meta.model, "m1");
      assert.deepEqual(outcomes(result.meta), ["ok"]);
      assert.equal(
        result.meta.attempts.some((attempt) => attempt.outcome === "probe"),
        false,
      );
      assert.equal(result.meta.fallback.attempts, 1);
      assert.equal("switchedFrom" in result.meta.fallback, false);
      assert.deepEqual(runCalls, [{ provider: "opencode", model: "m1" }]);
    },
  },
  {
    name: "probe false for opencode → no opencode client is created",
    run: async () => {
      const { deps, clientCalls } = scenario(
        { "openrouter/o1": [{ answer: "o1-answer" }] },
        { probe: async (entry) => entry.provider !== "opencode" },
      );
      const result = await runModelChain(deps);

      assert.equal(result.value, "o1-answer");
      assert.deepEqual(
        clientCalls,
        [{ provider: "openrouter", model: "o1" }],
        "opencode clients must not be created for either model",
      );
    },
  },
  {
    name: "excluded (tool_leak) provider is not probed again for its next model",
    run: async () => {
      const probeCalls: Array<string> = [];
      const { deps } = scenario(
        {
          "opencode/m1": [{ error: { code: "PROVIDER_TOOL_LEAK" } }],
          "openrouter/o1": [{ answer: "o1-answer" }],
        },
        {
          probe: async (entry) => {
            probeCalls.push(`${entry.provider}/${entry.model}`);
            return true;
          },
        },
      );
      const result = await runModelChain(deps);

      assert.equal(result.value, "o1-answer");
      assert.equal(result.meta.provider, "openrouter");
      assert.deepEqual(outcomes(result.meta), ["tool-leak", "ok"]);
      assert.deepEqual(
        probeCalls,
        ["opencode/m1", "openrouter/o1"],
        "the excluded provider's second model is skipped before the probe",
      );
    },
  },
  {
    name: "empty chain → EXTERNAL_UNAVAILABLE attempt 0, probe never called",
    run: async () => {
      const probeCalls: Array<string> = [];
      const { deps } = scenario(
        {},
        {
          chain: [],
          probe: async (entry) => {
            probeCalls.push(entry.provider);
            return true;
          },
        },
      );
      const err = await captureThrow(() => runModelChain(deps));

      assertUnavailable(err, 0);
      assert.deepEqual(probeCalls, []);
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
    console.error(`${failed}/${checks.length} model probe checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} model probe checks failed`);
  }
  console.log(`${checks.length}/${checks.length} model probe checks passed`);
}

void main().catch((error: unknown) => {
  console.error(
    `model probe checks failed to run: ${(error as Error).message}`,
  );
  process.exit(1);
});
