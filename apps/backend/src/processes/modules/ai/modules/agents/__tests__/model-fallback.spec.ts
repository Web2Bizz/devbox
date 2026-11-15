/**
 * Model chain — CompleteText/agent wiring checks — self-contained runner
 * (plain node:assert, no network, no real LLM client).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/agents/__tests__/model-fallback.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers card C5:
 * - ASK_FALLBACK_MODELS / isFailFastKeyError stay pinned (C0 contract);
 * - `completeText` walks the router through an in-process fetch fake: one
 *   success, provider switch on 404, fail-fast 404 `opencode_key_missing`
 *   without a fetch call;
 * - all four agents (Ask/Backend/Frontend/Fullstack) fail honestly without
 *   dependencies and pass the domain system prompt through the router when
 *   wired.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { HttpException, NotFoundException } from "@nestjs/common";
import { AskAgent } from "../ask.agent";
import { BACKEND_SYSTEM, BackendAgent } from "../backend.agent";
import { FRONTEND_SYSTEM, FrontendAgent } from "../frontend.agent";
import { FULLSTACK_SYSTEM, FullstackAgent } from "../fullstack.agent";
import {
  ASK_FALLBACK_MODELS,
  completeText,
  isFailFastKeyError,
  type TextCompletionDeps,
} from "../model-fallback";
import { MODEL_CHAIN } from "../model-provider";

type LogEntry = { level: string; message: string; correlationId?: string };

function fakeLogger(entries: Array<LogEntry>): unknown {
  const record =
    (level: string) =>
    (message: unknown, correlationId?: string): void => {
      entries.push({
        level,
        message: String(message),
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
    };
  return {
    debug: record("debug"),
    info: record("info"),
    log: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
  };
}

/** One stored secret row returned by the fake VaultService. */
function fakeKeys(hasKey = true): unknown {
  return {
    pickNext: async (consumer: { kind: string; userId?: string }, provider: string) =>
      hasKey
        ? {
            id: `${provider}-secret`,
            consumerKind: consumer.kind,
            consumerId: consumer.userId,
            provider,
            label: "default",
            encryptedKey: "enc",
            iv: "iv",
            keyId: "v1",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        : null,
    rewrap: async () => {
      throw new Error("rewrap must not be called when the key is active");
    },
    list: async () => [],
  };
}

/** Existing KEK envelope fake: decrypts to the test key, always fresh. */
const fakeCrypto = {
  decrypt: () => "sk-user",
  isActiveKeyId: () => true,
};

/** One captured fetch call (URL + parsed JSON body). */
type FetchCall = { url: string; body: Record<string, unknown> };

/** One scripted fetch step: a success text or an error status/body. */
type FetchStep = { status: number; content?: string; error?: unknown };

function openAiBody(content: string, model: string): unknown {
  return {
    id: "chatcmpl-test",
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
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function bodyText(raw: RequestInit["body"]): string | null {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  return null;
}

/**
 * Fake `fetch` serving `/chat/completions`: success steps return an
 * OpenAI-compatible completion whose `model` echoes the request, error steps
 * return the scripted status/body. Every call is recorded.
 */
function scriptedFetch(
  steps: Array<FetchStep>,
  calls: Array<FetchCall>,
): typeof fetch {
  let index = 0;
  const fn = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const raw = bodyText(init?.body);
    const body =
      raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    calls.push({ url, body });

    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === undefined) {
      throw new Error("unexpected fetch call without a scripted step");
    }
    if (step.status === 200) {
      const model = typeof body.model === "string" ? body.model : "";
      return new Response(JSON.stringify(openAiBody(step.content ?? "", model)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(step.error ?? {}), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  };
  return fn as typeof fetch;
}

function textDeps(
  calls: Array<FetchCall>,
  steps: Array<FetchStep>,
  overrides: Partial<TextCompletionDeps> = {},
): TextCompletionDeps {
  // One fake endpoint per test: every candidate's adapter talks to the same
  // scripted stream (a per-candidate fresh script would replay step 1 forever).
  const fetchFn = scriptedFetch(steps, calls);
  return {
    userId: "u1",
    prompt: "объясни",
    correlationId: "cid-1",
    keys: fakeKeys() as never,
    crypto: fakeCrypto as never,
    inprocessFetch: () => fetchFn,
    ...overrides,
  };
}

type AgentLike = {
  ask: (question: string, userId: string, correlationId?: string) => Promise<string>;
};

type AgentCase = {
  id: string;
  system?: string;
  make: (deps: {
    keys: unknown;
    crypto: unknown;
    opencodeFetch: unknown;
    logger: unknown;
  }) => AgentLike;
  makeBare: (logger: unknown) => AgentLike;
};

const AGENTS: Array<AgentCase> = [
  {
    id: "ask",
    make: ({ keys, crypto, opencodeFetch, logger }) =>
      new AskAgent(
        keys as never,
        crypto as never,
        opencodeFetch as never,
        logger as never,
      ),
    makeBare: (logger) =>
      new AskAgent(undefined, undefined, undefined, logger as never),
  },
  {
    id: "backend",
    system: BACKEND_SYSTEM,
    make: ({ keys, crypto, opencodeFetch, logger }) =>
      new BackendAgent(
        keys as never,
        crypto as never,
        opencodeFetch as never,
        logger as never,
      ),
    makeBare: (logger) =>
      new BackendAgent(undefined, undefined, undefined, logger as never),
  },
  {
    id: "frontend",
    system: FRONTEND_SYSTEM,
    make: ({ keys, crypto, opencodeFetch, logger }) =>
      new FrontendAgent(
        keys as never,
        crypto as never,
        opencodeFetch as never,
        logger as never,
      ),
    makeBare: (logger) =>
      new FrontendAgent(undefined, undefined, undefined, logger as never),
  },
  {
    id: "fullstack",
    system: FULLSTACK_SYSTEM,
    make: ({ keys, crypto, opencodeFetch, logger }) =>
      new FullstackAgent(
        keys as never,
        crypto as never,
        opencodeFetch as never,
        logger as never,
      ),
    makeBare: (logger) =>
      new FullstackAgent(undefined, undefined, undefined, logger as never),
  },
];

async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

type Check = { name: string; run: () => Promise<void> | void };

const checks: Array<Check> = [
  {
    name: "ASK_FALLBACK_MODELS is non-empty and pins the exact user-ordered ids",
    run: () => {
      assert.ok(ASK_FALLBACK_MODELS.length > 0);
      assert.deepEqual(
        [...ASK_FALLBACK_MODELS],
        [
          "deepseek-v4.1-flash",
          "deepseek-v4-pro",
          "qwen3.8-max",
          "glm-5.3-flash",
        ],
      );
    },
  },
  {
    name: "ASK_FALLBACK_MODELS has no duplicate ids",
    run: () => {
      assert.equal(
        new Set(ASK_FALLBACK_MODELS).size,
        ASK_FALLBACK_MODELS.length,
        `duplicate fallback model in ${JSON.stringify(ASK_FALLBACK_MODELS)}`,
      );
    },
  },
  {
    name: "isFailFastKeyError: 404 opencode_key_missing → true",
    run: () => {
      assert.equal(
        isFailFastKeyError(
          new HttpException({ code: "opencode_key_missing" }, 404),
        ),
        true,
      );
    },
  },
  {
    name: "isFailFastKeyError: 401 opencode_key_invalid → true",
    run: () => {
      assert.equal(
        isFailFastKeyError(
          new HttpException({ code: "opencode_key_invalid" }, 401),
        ),
        true,
      );
    },
  },
  {
    name: "isFailFastKeyError: 404/401 with any other code → false",
    run: () => {
      for (const status of [404, 401]) {
        for (const code of ["opencode_key_expired", "not_found", "", undefined]) {
          assert.equal(
            isFailFastKeyError(new HttpException({ code }, status)),
            false,
            `status=${status} code=${String(code)} must not fail fast`,
          );
        }
      }
    },
  },
  {
    name: "isFailFastKeyError: right code on 400/500/403 → false (status matters)",
    run: () => {
      for (const status of [400, 500, 403]) {
        assert.equal(
          isFailFastKeyError(
            new HttpException({ code: "opencode_key_missing" }, status),
          ),
          false,
          `missing key code on ${status} must not fail fast`,
        );
        assert.equal(
          isFailFastKeyError(
            new HttpException({ code: "opencode_key_invalid" }, status),
          ),
          false,
          `invalid key code on ${status} must not fail fast`,
        );
      }
    },
  },
  {
    name: "isFailFastKeyError: plain Error and hostile non-HttpException values → false",
    run: () => {
      for (const hostile of [
        new Error("opencode_key_missing"),
        null,
        undefined,
        0,
        42,
        "",
        "opencode_key_missing",
        [],
        {},
        { status: 404, response: { code: "opencode_key_missing" } },
      ]) {
        assert.equal(
          isFailFastKeyError(hostile),
          false,
          `must reject ${JSON.stringify(hostile)}`,
        );
      }
    },
  },
  {
    name: "isFailFastKeyError: HttpException with non-object response → false",
    run: () => {
      assert.equal(
        isFailFastKeyError(new HttpException("opencode_key_missing", 404)),
        false,
        "a string body must not be parsed as a code",
      );
      assert.equal(
        isFailFastKeyError(new HttpException(null as never, 404)),
        false,
        "a null body must not fail fast",
      );
    },
  },
  {
    name: "isFailFastKeyError: decided by status+code, not by message text",
    run: () => {
      assert.equal(
        isFailFastKeyError(
          new HttpException(
            {
              code: "opencode_key_missing",
              message: "everything exploded: opencode_key_invalid / 500",
            },
            404,
          ),
        ),
        true,
        "a scary message must not change the status+code decision",
      );
      assert.equal(
        isFailFastKeyError(
          new HttpException(
            {
              code: "some_other_error",
              message: "opencode_key_missing",
            },
            404,
          ),
        ),
        false,
        "the message text must never be used as the code",
      );
    },
  },
  {
    name: "completeText: in-process fetch returns the model text via the first chain candidate",
    run: async () => {
      const calls: Array<FetchCall> = [];
      const result = await completeText(
        textDeps(calls, [{ status: 200, content: "answer-1" }]),
      );
      assert.equal(result.value, "answer-1");
      assert.equal(calls.length, 1);
      assert.ok(
        calls[0]?.url.endsWith("/chat/completions"),
        `url must target /chat/completions, got ${calls[0]?.url ?? "<none>"}`,
      );
      assert.equal(calls[0]?.body.model, MODEL_CHAIN[0]?.model);
      assert.deepEqual(
        (calls[0]?.body.messages as Array<{ role: string }>).map((m) => m.role),
        ["user"],
        "completeText without a system prompt must send only the user message",
      );
      assert.equal(result.meta.fallback.switchedFrom, undefined);
    },
  },
  {
    name: "completeText: a system prompt is sent as the OpenAI system message",
    run: async () => {
      const calls: Array<FetchCall> = [];
      const result = await completeText(
        textDeps(calls, [{ status: 200, content: "answer-2" }], {
          system: BACKEND_SYSTEM,
        }),
      );
      assert.equal(result.value, "answer-2");
      const messages = calls[0]?.body.messages as Array<{
        role: string;
        content: string;
      }>;
      assert.deepEqual(
        messages.map((m) => m.role),
        ["system", "user"],
      );
      assert.equal(messages[0]?.content, BACKEND_SYSTEM);
      assert.equal(messages[1]?.content, "объясни");
    },
  },
  {
    name: "completeText: a 404 model switch walks to the next candidate",
    run: async () => {
      const calls: Array<FetchCall> = [];
      const result = await completeText(
        textDeps(calls, [
          { status: 404, error: { error: { code: "model_not_found" } } },
          { status: 200, content: "answer-next" },
        ]),
      );
      assert.equal(result.value, "answer-next");
      assert.equal(calls.length, 2);
      assert.equal(calls[1]?.body.model, MODEL_CHAIN[1]?.model);
      assert.equal(result.meta.fallback.switchedFrom, "opencode");
    },
  },
  {
    name: "completeText: a missing key fails fast with 404 opencode_key_missing",
    run: async () => {
      const calls: Array<FetchCall> = [];
      let fetchFactories = 0;
      const err = await captureThrow(() =>
        completeText(
          textDeps(calls, [{ status: 200, content: "unreachable" }], {
            keys: fakeKeys(false) as never,
            inprocessFetch: () => {
              fetchFactories += 1;
              return scriptedFetch([{ status: 200, content: "unreachable" }], calls);
            },
          }),
        ),
      );
      assert.ok(err instanceof NotFoundException);
      assert.equal((err as NotFoundException).getStatus(), 404);
      assert.equal(
        ((err as NotFoundException).getResponse() as { code?: string }).code,
        "opencode_key_missing",
      );
      assert.equal(fetchFactories, 0, "no fetch may be created without a key");
      assert.equal(calls.length, 0, "no model call may happen without a key");
    },
  },
];

for (const agent of AGENTS) {
  checks.push({
    name: `${agent.id}: without dependencies fails with a 'not wired' error`,
    run: async () => {
      const instance = agent.makeBare(fakeLogger([]));
      const err = await captureThrow(() => instance.ask("q", "u1", "cid"));
      assert.ok(err instanceof Error);
      assert.equal(
        (err as Error).message,
        `${capitalize(agent.id)}Agent: model provider dependencies are not wired`,
      );
    },
  });

  checks.push({
    name: `${agent.id}: wired dependencies return the router answer and pass the system prompt`,
    run: async () => {
      const entries: Array<LogEntry> = [];
      const calls: Array<FetchCall> = [];
      const fetchFn = scriptedFetch([{ status: 200, content: "router-answer" }], calls);
      const opencodeFetch = {
        create: () => fetchFn,
      };
      const instance = agent.make({
        keys: fakeKeys(),
        crypto: fakeCrypto,
        opencodeFetch,
        logger: fakeLogger(entries),
      });
      const result = await instance.ask("объясни", "u1", "cid-agent");
      assert.equal(result, "router-answer");
      assert.equal(calls.length, 1);
      const messages = calls[0]?.body.messages as Array<{
        role: string;
        content: string;
      }>;
      if (agent.system === undefined) {
        assert.deepEqual(
          messages.map((m) => m.role),
          ["user"],
          "AskAgent must not send a domain system prompt",
        );
        assert.equal(messages[0]?.content, "объясни");
      } else {
        assert.deepEqual(
          messages.map((m) => m.role),
          ["system", "user"],
        );
        assert.equal(messages[0]?.content, agent.system);
      }
      assert.ok(
        entries.some(
          (entry) => entry.message === `[agents] ${agent.id} via router`,
        ),
        `missing '[agents] ${agent.id} via router' log`,
      );
    },
  });
}

/** Agent class name from its registry id (ask → AskAgent, …). */
function capitalize(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

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
    console.error(`${failed}/${checks.length} model fallback checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} model fallback checks failed`);
  }
  console.log(`${checks.length}/${checks.length} model fallback checks passed`);
}

void main().catch((error: unknown) => {
  console.error(
    `model fallback checks failed to run: ${(error as Error).message}`,
  );
  process.exit(1);
});
