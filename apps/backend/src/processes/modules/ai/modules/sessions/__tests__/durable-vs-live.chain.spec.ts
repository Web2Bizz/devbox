import assert from "node:assert/strict";
import type { AppLogger } from "@common/logger";
import type { SessionHistoryRepository } from "../session-history.repository";
import { orderByParentChain } from "../session-history.repository";
import { AssistantRecorderService } from "../modules/recorder/assistant-recorder.service";
import { SessionRuntimeStateService } from "../modules/state/session-runtime-state.service";
import { SessionFrameBufferService } from "../modules/events/session-frame-buffer.service";
import { FileCommandTurnService } from "../modules/messaging/file-command.turn";
import { DirectTurnService } from "../modules/messaging/direct-turn.service";
import type { OpencodeHostService } from "../../opencode/opencode-host.service";
import type { WorkspacePathService } from "@common/storage/workspace-path.service";
import type { TurnWorkspaceService } from "../modules/workspace/turn-workspace.service";
import type { SessionRunnerService } from "@common/zen/session-runner.service";
import type { AgentsService } from "../../agents/agents.service";

/**
 * Durable chain (0012): tool/reasoning are durable links.
 * - recorder: tool.called/progress/success/failed persist kind=tool linked
 *   (first link → receipt ?? tail, next → prev link); reasoning
 *   started/delta/ended buffer into one kind=reasoning link of the same
 *   chain; the assistant closes on the last link. input.* markers live-only.
 * - file-command: receipt parent = body.parentId ?? tail; tool parent = receipt.id;
 *   assistant parent = tool.id (receipt -> tool -> assistant)
 * - direct: user->tail, assistant->receipt + live reasoning without tool frames (ask)
 * - reload: orderByParentChain keeps tools, second pass identical (GET chain parity)
 */
type Case = { name: string; run: () => Promise<void> | void };
const cases: Array<Case> = [];
let suite = "";
function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = "";
}
function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

function silentLogger(): AppLogger {
  return { debug() {}, info() {}, log() {}, warn() {}, error() {}, fatal() {} } as unknown as AppLogger;
}

const SID = "123e4567-e89b-12d3-a456-426614174010";
const LOCAL = "123e4567-e89b-12d3-a456-426614174010";

function hostFrame(type: string, sessionID: string, extra: Record<string, unknown> = {}): unknown {
  return { type, created: Date.now(), data: { sessionID, assistantMessageID: "am-1", ...extra } };
}

describe("AssistantRecorder durable chain", () => {
  function recorderHarness(): {
    svc: AssistantRecorderService;
    appended: Array<Record<string, unknown>>;
    tails: Array<string | null>;
  } {
    const appended: Array<Record<string, unknown>> = [];
    const tails: Array<string | null> = [];
    const history = {
      appendMessage: async (row: Record<string, unknown>) => {
        appended.push(row);
      },
      findTailId: async () => {
        tails.push("tail-1");
        return "tail-1";
      },
      getAgent: async () => null,
      findSessionByHostSessionId: async () => ({ id: LOCAL, projectId: "p1", userId: "u1" }),
    } as unknown as SessionHistoryRepository;
    const host = { subscribeEvents: async () => (async function* () {})() } as unknown as OpencodeHostService;
    const state = new SessionRuntimeStateService();
    const svc = new AssistantRecorderService(host, history, state, silentLogger());
    return { svc, appended, tails };
  }

  async function feed(svc: AssistantRecorderService, event: unknown): Promise<void> {
    await (svc as unknown as { recordHostEvent: (e: unknown) => Promise<void> }).recordHostEvent(event);
  }

  it("markers/input live-only: durable append НЕ зовётся", async () => {
    const { svc, appended } = recorderHarness();
    const liveOnly = [
      "session.tool.input.started",
      "session.tool.input.delta",
      "session.tool.input.ended",
      "session.text.started",
      "session.step.started",
    ];
    for (const type of liveOnly) {
      await feed(svc, hostFrame(type, "ses_host_1", { delta: "x", tool: "bash" }));
    }
    assert.equal(appended.length, 0, `live-only кадры обязаны не писать durable: ${liveOnly.join(",")}`);
  });

  it("tool.called/progress/success/failed пишут kind=tool linked-цепочкой", async () => {
    const { svc, appended } = recorderHarness();
    await feed(svc, hostFrame("session.tool.called", "ses_host_1", { tool: "bash" }));
    await feed(svc, hostFrame("session.tool.success", "ses_host_1", { tool: "bash", text: "ok" }));
    assert.equal(appended.length, 2);
    assert.equal(appended[0]!["kind"], "tool");
    assert.equal(appended[0]!["role"], "tool");
    assert.equal(appended[0]!["name"], "bash");
    assert.equal(appended[0]!["status"], "called");
    assert.equal(appended[0]!["parentId"], "tail-1");
    assert.equal(appended[1]!["status"], "done");
    assert.equal(
      appended[1]!["parentId"],
      appended[0]!["id"],
      "второй tool линкуется к первому, а не sibling под receipt",
    );
  });

  it("assistant закрывает цепочку на последнем tool-линке", async () => {
    const { svc, appended } = recorderHarness();
    await feed(svc, hostFrame("session.tool.called", "ses_host_1", { tool: "bash" }));
    await feed(svc, hostFrame("session.text.delta", "ses_host_1", { delta: "hello " }));
    await feed(svc, hostFrame("session.text.ended", "ses_host_1", { text: "hello" }));
    assert.equal(appended.length, 2);
    assert.equal(appended[0]!["kind"], "tool");
    assert.equal(appended[1]!["role"], "assistant");
    assert.equal(
      appended[1]!["parentId"],
      appended[0]!["id"],
      "assistant parent = last tool id (receipt -> tool -> assistant)",
    );
  });

  it("reasoning started/delta/ended пишут ОДИН kind=reasoning ряд", async () => {
    const { svc, appended } = recorderHarness();
    await feed(svc, hostFrame("session.reasoning.started", "ses_host_1", {}));
    await feed(svc, hostFrame("session.reasoning.delta", "ses_host_1", { delta: "думаю " }));
    await feed(svc, hostFrame("session.reasoning.delta", "ses_host_1", { delta: "дальше" }));
    assert.equal(appended.length, 0, "дельты reasoning копятся, не пишут по одной");
    await feed(svc, hostFrame("session.reasoning.ended", "ses_host_1", {}));
    assert.equal(appended.length, 1);
    assert.equal(appended[0]!["kind"], "reasoning");
    assert.equal(appended[0]!["role"], "reasoning");
    assert.equal(appended[0]!["text"], "думаю дальше");
    assert.equal(appended[0]!["parentId"], "tail-1");
  });

  it("text durable: delta+ended пишут ОДИН assistant ряд с parentId=tail", async () => {
    const { svc, appended } = recorderHarness();
    await feed(svc, hostFrame("session.text.delta", "ses_host_1", { delta: "hello " }));
    await feed(svc, hostFrame("session.text.delta", "ses_host_1", { delta: "world" }));
    assert.equal(appended.length, 0, "дельты копятся, не пишут по одной");
    await feed(svc, hostFrame("session.text.ended", "ses_host_1", { text: "hello world" }));
    assert.equal(appended.length, 1);
    assert.equal(appended[0]!["role"], "assistant");
    assert.equal(appended[0]!["text"], "hello world");
    assert.equal(appended[0]!["parentId"], "tail-1", "durable текст линкуется к хвосту цепочки (tip)");
  });

  it("hostile: пустая дельта и отсутствие assistantMessageID не пишут ряд", async () => {
    const { svc, appended } = recorderHarness();
    await feed(svc, hostFrame("session.text.delta", "ses_host_1", { delta: "" }));
    await feed(svc, { type: "session.text.ended", created: Date.now(), data: { sessionID: "ses_host_1" } });
    await feed(svc, { type: "session.text.delta", created: Date.now(), data: {} });
    assert.equal(appended.length, 0);
  });

  it("hostile: null/undefined кадры не роняют рекордер", async () => {
    const { svc, appended } = recorderHarness();
    await feed(svc, null);
    await feed(svc, undefined);
    await feed(svc, { type: 42, data: null });
    assert.equal(appended.length, 0);
  });
});

describe("FileCommand chain links", () => {
  function harness(tail: string | null = "tail-9"): {
    svc: FileCommandTurnService;
    appended: Array<Record<string, unknown>>;
  } {
    const appended: Array<Record<string, unknown>> = [];
    const history = {
      setAgent: async () => {},
      findTailId: async () => tail,
      resolveAppendParent: async (
        _sessionId: string,
        parentId: string | null | undefined,
      ) => (parentId !== undefined ? parentId : tail),
      appendMessage: async (row: Record<string, unknown>) => {
        appended.push(row);
      },
    } as unknown as SessionHistoryRepository;
    const host = { sessionShell: async () => ({ output: "hi" }) } as unknown as OpencodeHostService;
    const workspace = { captureBeforeTurn: async () => {} } as unknown as TurnWorkspaceService;
    const state = new SessionRuntimeStateService();
    const buffer = new SessionFrameBufferService();
    const paths = {
      ensureDir: async () => {},
      writeFile: async () => {},
      readFile: async () => "body",
    } as unknown as WorkspacePathService;
    const svc = new FileCommandTurnService(host, history, workspace, state, buffer, paths, silentLogger());
    return { svc, appended };
  }

  it("user receipt parentId = body.parentId ?? tail; tool parent = receipt; assistant parent = tool", async () => {
    const { svc, appended } = harness("tail-9");
    const receipt = await svc.tryHandle({
      userId: "u1",
      sessionId: SID,
      body: { projectId: "p1", text: "создай файл a.txt с текстом hi" } as never,
      directory: "/repo",
      agentId: "ask",
      correlationId: "cid",
    });
    assert.ok(receipt);
    assert.equal(appended.length, 3);
    assert.equal(appended[0]!["parentId"], "tail-9");
    assert.equal(appended[0]!["role"], "user");
    assert.equal(appended[1]!["parentId"], (receipt as { id: string }).id);
    assert.equal(appended[1]!["role"], "tool");
    assert.equal(appended[1]!["kind"], "tool");
    assert.equal(appended[1]!["name"], "write");
    assert.equal(appended[2]!["role"], "assistant");
    assert.equal(appended[2]!["parentId"], appended[1]!["id"]);
  });

  it("явный body.parentId побеждает tail (ответвление ветки)", async () => {
    const { svc, appended } = harness("tail-9");
    await svc.tryHandle({
      userId: "u1",
      sessionId: SID,
      body: { projectId: "p1", text: "создай файл a.txt с текстом hi", parentId: "branch-tip" } as never,
      directory: "/repo",
      agentId: "ask",
      correlationId: "cid",
    });
    assert.equal(appended[0]!["parentId"], "branch-tip");
  });
});

describe("DirectTurn chain links + live-only", () => {
  function harness(): { svc: DirectTurnService; appended: Array<Record<string, unknown>>; buffer: SessionFrameBufferService } {
    const appended: Array<Record<string, unknown>> = [];
    const history = {
      setAgent: async () => {},
      findTailId: async () => "tail-d",
      resolveAppendParent: async (_sessionId: string, parentId: string | null | undefined) =>
        parentId !== undefined ? parentId : "tail-d",
      appendMessage: async (row: Record<string, unknown>) => {
        appended.push(row);
      },
    } as unknown as SessionHistoryRepository;
    const workspace = { captureBeforeTurn: async () => {} } as unknown as TurnWorkspaceService;
    const state = new SessionRuntimeStateService();
    const buffer = new SessionFrameBufferService();
    const runner = {} as unknown as SessionRunnerService;
    const agents = { askQuestion: async () => "answer" } as unknown as AgentsService;
    const svc = new DirectTurnService(history, workspace, state, buffer, runner, agents, silentLogger());
    return { svc, appended, buffer };
  }

  it("user→tail, assistant→receipt; live reasoning без tool-фреймов ask", async () => {
    const { svc, appended, buffer } = harness();
    const receipt = await svc.send({
      userId: "u1",
      sessionId: SID,
      body: { projectId: "p1", text: "hi" } as never,
      directory: "/repo",
      agentId: "ask",
      correlationId: "cid",
    });
    assert.equal(appended.length, 2);
    assert.equal(appended[0]!["parentId"], "tail-d");
    assert.equal(appended[1]!["parentId"], (receipt as { id: string }).id);
    const types = buffer.list().map((f) => f.type);
    assert.ok(types.includes("session.reasoning.started"), "direct обязан слать reasoning live-only");
    assert.ok(!types.some((t) => t.startsWith("session.tool.")), "ask — не tool: session.tool.* запрещены");
  });
});

describe("Reload parity with tools", () => {
  it("orderByParentChain держит tools: user->tool->assistant, повтор идентичен", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-01-01T00:00:01.000Z");
    const t2 = new Date("2026-01-01T00:00:02.000Z");
    const rows = [
      { id: "u1", parentId: null, createdAt: t0 },
      { id: "tool-1", parentId: "u1", createdAt: t1 },
      { id: "a1", parentId: "tool-1", createdAt: t2 },
    ];
    const first = orderByParentChain(rows);
    assert.deepEqual(first.map((r) => r.id), ["u1", "tool-1", "a1"]);
    const second = orderByParentChain(first);
    assert.deepEqual(second.map((r) => r.id), first.map((r) => r.id));
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`durable-vs-live checks failed: ${(err as Error).message}`);
  process.exit(1);
});
