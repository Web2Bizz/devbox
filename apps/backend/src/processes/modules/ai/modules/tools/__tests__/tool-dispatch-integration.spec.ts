import assert from "node:assert/strict";
import path from "node:path";
import { WorkspacePathService } from "@common/storage/workspace-path.service";
import { ToolDispatchService } from "../../tool-dispatch/tool-dispatch.service";
import { ToolRegistryService } from "../../tool-registry/tool-registry.service";
import type { ToolCall } from "../../tool-runtime/tool-runtime.types";
import { ReadTool } from "../read.tool";
import { ShellTool } from "../shell.tool";
import { WriteTool } from "../write.tool";

/**
 * Real-handler wiring of the sibling `tool-runtime` (direction
 * `tools → tool-runtime` is allowed): dispatch semantics themselves are
 * covered by `tool-dispatch/__tests__/tool-dispatch.spec.ts` with stubs,
 * while this spec asserts the actual filesystem jail and shell allowlist of
 * the real `read`/`write`/`shell` handlers reached through the dispatcher.
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
  return { id, name, arguments: JSON.stringify(args) };
}

/** Dispatcher over the REAL `read`/`write`/`shell` handlers (temp project dir). */
async function makeDispatcher(): Promise<{
  dispatch: (calls: Array<ToolCall>) => Promise<Array<string>>;
  directory: string;
}> {
  const paths: WorkspacePathService = new WorkspacePathService();
  const directory: string = path.join("/tmp/opencode", `tools-${crypto.randomUUID()}`);
  await paths.ensureDir(directory);
  const registry: ToolRegistryService = new ToolRegistryService();
  registry.register(new ReadTool(paths));
  registry.register(new WriteTool(paths));
  registry.register(new ShellTool());
  const dispatcher: ToolDispatchService = new ToolDispatchService(registry);
  return {
    directory,
    dispatch: async (calls) =>
      (await dispatcher.dispatch(calls, { directory, sessionId: "s1" }, 1)).map(
        (row) => row.result,
      ),
  };
}

describe("ToolDispatchService over real handlers", () => {
  it("refuses a relative path escaping the jail", async () => {
    const { dispatch } = await makeDispatcher();
    const [result] = await dispatch([call("1", "read", { path: "../../etc/passwd" })]);
    assert.equal(result, "error: path escapes the project");
  });

  it("refuses an absolute path", async () => {
    const { dispatch } = await makeDispatcher();
    const [result] = await dispatch([call("1", "read", { path: "/etc/passwd" })]);
    assert.equal(result, "error: path escapes the project");
  });

  it("reads back what write stored", async () => {
    const { dispatch } = await makeDispatcher();
    const results = await dispatch([
      call("1", "write", { path: "notes.txt", content: "hello jail" }),
      call("2", "read", { path: "notes.txt" }),
    ]);
    assert.equal(results[0], "wrote 10 bytes to notes.txt");
    assert.equal(results[1], "hello jail");
  });

  it("refuses a shell command outside the allowlist", async () => {
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

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
