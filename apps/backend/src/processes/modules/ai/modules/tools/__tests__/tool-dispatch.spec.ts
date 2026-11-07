import assert from "node:assert/strict";
import path from "node:path";
import { WorkspacePathService } from "../../../../../../common/storage/workspace-path.service";
import { ReadTool } from "../read.tool";
import { ShellTool } from "../shell.tool";
import { ToolDispatchService } from "../tool-dispatch.service";
import { ToolRegistryService } from "../tool-registry.service";
import type { ToolCall } from "../tool.types";
import { WriteTool } from "../write.tool";

/**
 * Dispatch semantics (donor `dispatch/runTools`): unknown tool and invalid
 * JSON settle as error-results (never throw), jail escapes are refused, and
 * settlement order equals call order under bounded concurrency.
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

function call(id: string, name: string, args: unknown): ToolCall {
  return { id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
}

async function makeDispatcher(): Promise<{
  dispatch: (calls: Array<ToolCall>, concurrency?: number) => Promise<Array<string>>;
  directory: string;
}> {
  const paths = new WorkspacePathService();
  const directory = path.join("/tmp/opencode", `tools-${crypto.randomUUID()}`);
  await paths.ensureDir(directory);
  await paths.writeFile(path.join(directory, "a.txt"), "alpha");
  const registry = new ToolRegistryService();
  registry.register(new ReadTool(paths));
  registry.register(new WriteTool(paths));
  registry.register(new ShellTool());
  const dispatcher = new ToolDispatchService(registry);
  return {
    directory,
    dispatch: async (calls, concurrency) =>
      (await dispatcher.dispatch(calls, { directory, sessionId: "s1" }, concurrency)).map(
        (row) => row.result,
      ),
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

  it("outside-jail path is refused with an error-result", async () => {
    const { dispatch } = await makeDispatcher();
    const [result] = await dispatch([call("1", "read", { path: "../../etc/passwd" })]);
    assert.ok(result?.startsWith("error: path escapes the project"), result);
  });

  it("absolute path is refused too", async () => {
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

  it("shell refuses a non-allowlisted binary", async () => {
    const { dispatch } = await makeDispatcher();
    const [result] = await dispatch([call("1", "shell", { command: "rm -rf /" })]);
    assert.equal(result, 'error: command "rm" is not allowed');
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
