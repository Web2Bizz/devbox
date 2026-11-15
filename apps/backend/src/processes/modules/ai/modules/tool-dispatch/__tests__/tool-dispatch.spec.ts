import assert from "node:assert/strict";
import path from "node:path";
import { WorkspacePathService } from "@common/storage/workspace-path.service";
import { ToolDispatchService, InMemoryToolEffectsStore, isMutatingToolName } from "../tool-dispatch.service";
import { ToolRegistryService } from "../../tool-registry/tool-registry.service";
import type { ToolCall, ToolHandler } from "../../tool-runtime/tool-runtime.types";

/**
 * Dispatch semantics (donor `dispatch/runTools`): unknown tool and invalid
 * JSON settle as error-results (never throw), handler errors (jail escapes,
 * refused commands) are propagated as error-results, and settlement order
 * equals call order under bounded concurrency. Handlers here are throwaway
 * stubs — the real filesystem/shell behaviour is covered by the sibling
 * `tools` module's `__tests__/tool-dispatch-integration.spec.ts`.
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

function call(id: string, name: string, args: unknown, effectKey?: string): ToolCall {
  return {
    id,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
    ...(effectKey !== undefined ? { effectKey } : {}),
  };
}

/** Dispatcher over one counting `write` handler (no real fs effect). */
async function makeCountingDispatcher(
  behavior: () => string = () => "wrote once",
): Promise<{
  dispatcher: ToolDispatchService;
  directory: string;
  executedCount: () => number;
}> {
  const directory = path.join("/tmp/opencode", `tools-${crypto.randomUUID()}`);
  await new WorkspacePathService().ensureDir(directory);
  const registry = new ToolRegistryService();
  let executed = 0;
  registry.register({
    fullName: "write",
    definition: { name: "write", description: "write", inputSchema: { type: "object" } },
    execute: async () => {
      executed += 1;
      return behavior();
    },
  });
  return {
    dispatcher: new ToolDispatchService(registry),
    directory,
    executedCount: () => executed,
  };
}

/** Inputs the inline stubs accept (mirrors the real handlers' wire shapes). */
type ReadInput = { path: string };
type WriteInput = { path: string; content: string };
type ShellInput = { command: string };

/** Lexical jail of the read stub: absolute input and `..` segments escape. */
function escapesProject(targetPath: string): boolean {
  return (
    path.isAbsolute(targetPath) ||
    targetPath.startsWith("../") ||
    targetPath.includes("/../")
  );
}

async function makeDispatcher(mode?: "auto" | "ask"): Promise<{
  dispatch: (calls: Array<ToolCall>, concurrency?: number) => Promise<Array<string>>;
  directory: string;
}> {
  const paths: WorkspacePathService = new WorkspacePathService();
  const directory: string = path.join("/tmp/opencode", `tools-${crypto.randomUUID()}`);
  await paths.ensureDir(directory);
  const files: Map<string, string> = new Map<string, string>([["a.txt", "alpha"]]);
  const registry: ToolRegistryService = new ToolRegistryService();
  const readTool: ToolHandler = {
    fullName: "read",
    definition: { name: "read", description: "read", inputSchema: { type: "object" } },
    execute: async (input: unknown): Promise<string> => {
      const { path: targetPath }: ReadInput = input as ReadInput;
      if (escapesProject(targetPath)) throw new Error("path escapes the project");
      return files.get(targetPath) ?? `error: file not found "${targetPath}"`;
    },
  };
  const writeTool: ToolHandler = {
    fullName: "write",
    definition: { name: "write", description: "write", inputSchema: { type: "object" } },
    execute: async (input: unknown): Promise<string> => {
      const { path: targetPath, content }: WriteInput = input as WriteInput;
      files.set(targetPath, content);
      return `wrote ${content.length} bytes to ${targetPath}`;
    },
  };
  const shellTool: ToolHandler = {
    fullName: "shell",
    definition: { name: "shell", description: "shell", inputSchema: { type: "object" } },
    execute: async (input: unknown): Promise<string> => {
      const { command }: ShellInput = input as ShellInput;
      if (command.trim().startsWith("rm")) throw new Error('command "rm" is not allowed');
      return "ok";
    },
  };
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(shellTool);
  const dispatcher: ToolDispatchService = new ToolDispatchService(registry);
  return {
    directory,
    dispatch: async (calls, concurrency) =>
      (
        await dispatcher.dispatch(
          calls,
          { directory, sessionId: "s1", ...(mode !== undefined ? { mode } : {}) },
          concurrency,
        )
      ).map((row) => row.result),
  };
}

describe("ToolDispatchService", () => {
  it("unknown tool is an error-result, not a throw", async () => {
    const { dispatch } = await makeDispatcher();
    const [result] = await dispatch([call("1", "nope", {})]);
    assert.equal(result, 'error: unknown tool "nope"');
  });

  it("invalid JSON arguments answer a retry hint", async () => {
    const { dispatch } = await makeDispatcher();
    const [result] = await dispatch([call("1", "read", "{not json")]);
    assert.equal(result, "error: invalid JSON arguments, retry with valid JSON");
  });

  it("propagates a stub read error for an outside-jail path", async () => {
    const { dispatch } = await makeDispatcher();
    const [result] = await dispatch([call("1", "read", { path: "../../etc/passwd" })]);
    assert.ok(result?.startsWith("error: path escapes the project"), result);
  });

  it("propagates a stub read error for an absolute path too", async () => {
    const { dispatch } = await makeDispatcher();
    const [result] = await dispatch([call("1", "read", { path: "/etc/passwd" })]);
    assert.ok(result?.startsWith("error: path escapes the project"), result);
  });

  it("orders settlements like calls under concurrency", async () => {
    const { dispatch } = await makeDispatcher();
    const results = await dispatch([
      call("1", "write", { path: "b.txt", content: "bee" }),
      call("2", "read", { path: "a.txt" }),
      call("3", "nope", {}),
      call("4", "read", { path: "../../etc/passwd" }),
    ], 1);
    assert.equal(results.length, 4);
    assert.ok(results[0]?.startsWith("wrote 3 bytes"), results[0]);
    assert.equal(results[1], "alpha");
    assert.ok(results[2]?.includes("unknown tool"), results[2]);
    assert.ok(results[3]?.startsWith("error: path escapes"), results[3]);
  });

  it("runs a write then a read sequentially when concurrency is 1", async () => {
    const { dispatch } = await makeDispatcher();
    const results = await dispatch([
      call("1", "write", { path: "c.txt", content: "see" }),
      call("2", "read", { path: "c.txt" }),
    ], 1);
    assert.equal(results[1], "see");
  });

  it("propagates a stub shell error for a refused command", async () => {
    const { dispatch } = await makeDispatcher();
    const [result] = await dispatch([call("1", "shell", { command: "rm -rf /" })]);
    assert.equal(result, 'error: command "rm" is not allowed');
  });

  it("ask mode refuses write without calling the handler", async () => {
    const directory = path.join("/tmp/opencode", `tools-${crypto.randomUUID()}`);
    await new WorkspacePathService().ensureDir(directory);
    const registry = new ToolRegistryService();
    let executed = 0;
    registry.register({
      fullName: "write",
      definition: { name: "write", description: "write", inputSchema: { type: "object" } },
      execute: async () => {
        executed += 1;
        return "wrote";
      },
    });
    const dispatcher = new ToolDispatchService(registry);
    const [row] = await dispatcher.dispatch(
      [call("1", "write", { path: "x.txt", content: "x" })],
      { directory, sessionId: "s1", mode: "ask" },
    );
    assert.equal(row?.result, 'error: tool "write" is not allowed in ask mode (read-only)');
    assert.equal(executed, 0);
  });

  it("ask mode still executes read", async () => {
    const { dispatch } = await makeDispatcher("ask");
    const [result] = await dispatch([call("1", "read", { path: "a.txt" })]);
    assert.equal(result, "alpha");
  });

  it("ask mode refuses shell/edit/patch and unknown names", async () => {
    const { dispatch } = await makeDispatcher("ask");
    const names = ["shell", "edit", "patch", "nope"];
    for (const [index, name] of names.entries()) {
      const [result] = await dispatch([call(String(index), name, {})]);
      assert.equal(
        result,
        `error: tool "${name}" is not allowed in ask mode (read-only)`,
        name,
      );
    }
  });

  it("auto mode executes write", async () => {
    const { dispatch } = await makeDispatcher("auto");
    const [result] = await dispatch([call("1", "write", { path: "z.txt", content: "zed" })]);
    assert.ok(result?.startsWith("wrote 3 bytes"), result);
  });

  it("isMutatingToolName is fail-closed", () => {
    const expectations: Array<[string, boolean]> = [
      ["read", false],
      ["glob", false],
      ["grep", false],
      ["todo", false],
      ["native:read", false],
      ["native:glob", false],
      ["native:grep", false],
      ["native:todo", false],
      ["write", true],
      ["edit", true],
      ["patch", true],
      ["shell", true],
      ["native:write", true],
      ["native:edit", true],
      ["git.recon", true],
      ["mcp:search", true],
      ["unknown", true],
      ["", true],
    ];
    for (const [name, expected] of expectations) {
      assert.equal(isMutatingToolName(name), expected, name);
    }
  });

  it("dedups a committed effectKey without re-running the handler", async () => {
    const { dispatcher, directory, executedCount } = await makeCountingDispatcher();
    const effects = new InMemoryToolEffectsStore();
    const context = { directory, sessionId: "s1" };
    const first = await dispatcher.dispatch(
      [call("1", "write", {}, "r1:0:1")],
      context,
      1,
      effects,
    );
    const second = await dispatcher.dispatch(
      [call("1", "write", {}, "r1:0:1")],
      context,
      1,
      effects,
    );
    assert.equal(first[0]?.result, "wrote once");
    assert.equal(second[0]?.result, "wrote once");
    assert.equal(executedCount(), 1);
  });

  it("answers an in-progress effect as an error-result", async () => {
    const { dispatcher, directory, executedCount } = await makeCountingDispatcher();
    const effects = {
      begin: async () => ({ state: "in-progress" as const }),
      commit: async () => undefined,
    };
    const [row] = await dispatcher.dispatch(
      [call("1", "write", {}, "r1:0:1")],
      { directory, sessionId: "s1" },
      1,
      effects,
    );
    assert.equal(row?.result, "error: effect already in progress");
    assert.equal(executedCount(), 0);
  });

  it("commits an error-result too and replays it", async () => {
    const { dispatcher, directory, executedCount } = await makeCountingDispatcher(() => {
      throw new Error("boom");
    });
    const effects = new InMemoryToolEffectsStore();
    const context = { directory, sessionId: "s1" };
    const first = await dispatcher.dispatch(
      [call("1", "write", {}, "r1:0:1")],
      context,
      1,
      effects,
    );
    const second = await dispatcher.dispatch(
      [call("1", "write", {}, "r1:0:1")],
      context,
      1,
      effects,
    );
    assert.equal(first[0]?.result, "error: boom");
    assert.equal(second[0]?.result, "error: boom");
    assert.equal(executedCount(), 1);
  });

  it("executes twice when the call has no effectKey", async () => {
    const { dispatcher, directory, executedCount } = await makeCountingDispatcher();
    const effects = new InMemoryToolEffectsStore();
    const context = { directory, sessionId: "s1" };
    await dispatcher.dispatch([call("1", "write", {})], context, 1, effects);
    await dispatcher.dispatch([call("1", "write", {})], context, 1, effects);
    assert.equal(executedCount(), 2);
  });

  it("keeps the old behaviour when no effects store is passed", async () => {
    const { dispatcher, directory, executedCount } = await makeCountingDispatcher();
    const context = { directory, sessionId: "s1" };
    await dispatcher.dispatch([call("1", "write", {}, "r1:0:1")], context, 1);
    await dispatcher.dispatch([call("1", "write", {}, "r1:0:1")], context, 1);
    assert.equal(executedCount(), 2);
  });

  it("runs the handler once for two same-key calls in one dispatch", async () => {
    const { dispatcher, directory, executedCount } = await makeCountingDispatcher();
    const effects = new InMemoryToolEffectsStore();
    const rows = await dispatcher.dispatch(
      [call("1", "write", {}, "r1:0:1"), call("2", "write", {}, "r1:0:1")],
      { directory, sessionId: "s1" },
      4,
      effects,
    );
    assert.equal(executedCount(), 1);
    assert.equal(rows[0]?.result, "wrote once");
    assert.equal(rows[1]?.result, "error: effect already in progress");
  });
});

async function main(): Promise<void> {
  for (const item of cases) {
    await item.run();
    console.log(`ok ${item.name}`);
  }
  console.log(`done ${cases.length}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
