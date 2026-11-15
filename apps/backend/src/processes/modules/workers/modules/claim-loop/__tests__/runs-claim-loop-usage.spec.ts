/**
 * RunsClaimLoop llm.call usage characterization — self-contained runner
 * (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/workers/modules/claim-loop/__tests__/runs-claim-loop-usage.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Pins the CURRENT `{ type: 'done'; usage }` contract of the model gateway as
 * consumed by the claim loop (card C0):
 * - the terminal `done` event's usage is journaled in the committed llm.call
 *   resultRef (deltas are concatenated into text);
 * - no `done` event leaves the zero usage default `{ inputTokens: 0, outputTokens: 0 }`;
 * - a stream failure fails the step with LLM_CALL_FAILED and never commits.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import type { RunRow } from "@common/db/schema";
import type { ModelEvent } from "../../model-gateway/model-gateway";
import { RunsClaimLoop } from "../runs-claim-loop.service";

type CommitInput = {
  seq: number;
  type: string;
  resultRef: Record<string, unknown>;
};

type FailInput = { error?: { code?: string; message?: string } };

function runRow(): RunRow {
  return {
    id: "run-1",
    projectId: "project-1",
    title: "characterize usage",
    status: "open",
    definitionSetHash: "sha256:abcdef0",
    baseCommit: "abcdef0",
    branch: "agent/run-1",
    worktree: "/tmp/wt",
    sandboxId: null,
    agentId: null,
    model: { id: "test-model" },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  } as unknown as RunRow;
}

function eventsStream(
  events: Array<ModelEvent>,
  failure?: unknown,
): AsyncIterable<ModelEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
      for (const event of events) yield event;
      if (failure !== undefined) throw failure;
    },
  };
}

function makeLoop(options: {
  events: Array<ModelEvent>;
  failure?: unknown;
}): {
  loop: RunsClaimLoop;
  commits: Array<CommitInput>;
  failures: Array<FailInput>;
  finished: Array<string>;
} {
  const commits: Array<CommitInput> = [];
  const failures: Array<FailInput> = [];
  const finished: Array<string> = [];
  const repo = {
    claimNextRun: async (): Promise<RunRow> => runRow(),
    listSteps: async (): Promise<Array<unknown>> => [],
    startStep: async (): Promise<void> => undefined,
    commitStep: async (input: CommitInput): Promise<void> => {
      commits.push(input);
    },
    failStep: async (input: FailInput): Promise<void> => {
      failures.push(input);
    },
    finishRun: async (...args: Array<unknown>): Promise<void> => {
      finished.push(String(args[2]));
    },
  };
  const worktree = {
    ensure: async (): Promise<void> => undefined,
    commit: async (): Promise<unknown> => {
      throw new Error("git.commit must not run on the llm.call step");
    },
  };
  const executors = {
    resolve: () => ({
      id: "default",
      stream: () => eventsStream(options.events, options.failure),
    }),
  };
  const tools = {
    listViews: (): Array<unknown> => [],
    invoke: async (): Promise<unknown> => {
      throw new Error("tool.call must not run on the llm.call step");
    },
  };
  const sandbox = {
    exec: async (): Promise<unknown> => {
      throw new Error("sandbox.exec must not run on the llm.call step");
    },
  };
  const skills = {
    loadForRun: async (): Promise<unknown> => ({
      skills: [],
      system: "",
      allowedTools: new Set<string>(),
      effects: [],
    }),
    filterToolViews: (views: Array<unknown>): Array<unknown> => views,
  };
  const logger = {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  };
  const loop = new RunsClaimLoop(
    repo as never,
    worktree as never,
    executors as never,
    tools as never,
    sandbox as never,
    skills as never,
    logger as never,
  );
  return { loop, commits, failures, finished };
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "llm.call journals the terminal done usage and concatenated deltas",
    run: async () => {
      const { loop, commits, failures, finished } = makeLoop({
        events: [
          { type: "delta", text: "hel" },
          { type: "delta", text: "lo" },
          { type: "done", usage: { inputTokens: 3, outputTokens: 5 } },
        ],
      });
      const worked = await loop.tick();
      assert.equal(worked, true);
      assert.equal(failures.length, 0, "a clean stream must not fail the step");
      assert.equal(finished.length, 0, "a committed step must not finish the run");
      assert.equal(commits.length, 1, "exactly one llm.call step is committed");
      const resultRef = commits[0].resultRef;
      assert.deepEqual(resultRef.usage, { inputTokens: 3, outputTokens: 5 });
      assert.equal(resultRef.text, "hello");
      assert.equal(resultRef.model, "test-model");
      assert.equal(resultRef.definitionSetHash, "sha256:abcdef0");
    },
  },
  {
    name: "llm.call without a done event journals the zero usage default",
    run: async () => {
      const { loop, commits, failures } = makeLoop({
        events: [{ type: "delta", text: "partial" }],
      });
      await loop.tick();
      assert.equal(failures.length, 0);
      assert.equal(commits.length, 1);
      assert.deepEqual(commits[0].resultRef.usage, { inputTokens: 0, outputTokens: 0 });
      assert.equal(commits[0].resultRef.text, "partial");
    },
  },
  {
    name: "llm.call stream failure fails the step, never commits usage",
    run: async () => {
      const { loop, commits, failures, finished } = makeLoop({
        events: [{ type: "delta", text: "half" }],
        failure: new Error("provider exploded"),
      });
      await loop.tick();
      assert.equal(commits.length, 0, "a failed stream must not commit a result");
      assert.equal(failures.length, 1);
      assert.equal(failures[0].error?.code, "LLM_CALL_FAILED");
      assert.deepEqual(finished, ["failed"]);
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
    console.error(`${failed}/${checks.length} claim-loop usage checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} claim-loop usage checks failed`);
  }
  console.log(`${checks.length}/${checks.length} claim-loop usage checks passed`);
}

void main().catch((error: unknown) => {
  console.error(
    `claim-loop usage checks failed to run: ${(error as Error).message}`,
  );
  process.exit(1);
});
