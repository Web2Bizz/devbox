/**
 * ToolRegistryService checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/tool-registry/__tests__/tool-registry.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: register → resolve of the same handler, duplicate name is last-wins
 * (single entry, warn logged), `listForPrompt` answers the definitions,
 * `names` keeps registration order and unknown names resolve to null.
 * `listViews`/`toolViewsFromDefinitions` project every definition into one
 * `native:<name>` ToolView in registration order (mutating flags follow
 * `isMutatingToolView`: read/glob/grep/todo read-only, write/edit/patch/shell
 * mutating).
 */
import assert from "node:assert/strict";
import type { ToolView } from "@rush-code/contracts";
import {
  toolViewsFromDefinitions,
  type ToolContext,
  type ToolHandler,
} from "../../tool-runtime/tool-runtime.types";
import { isMutatingToolView } from "../../tools/utils/langchain-tools/langchain-tools.util";
import { ToolRegistryService } from "../tool-registry.service";

type Case = { name: string; run: () => void };
const cases: Array<Case> = [];
let suite = "";

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = "";
}

function it(name: string, run: () => void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

/** One registered tool: definition mirrors `fullName`, execute is a string. */
function makeTool(fullName: string, description: string = fullName): ToolHandler {
  return {
    fullName,
    definition: { name: fullName, description, inputSchema: { type: "object" } },
    execute: async (_input: unknown, _context: ToolContext): Promise<string> =>
      `ran ${fullName}`,
  };
}

describe("ToolRegistryService", () => {
  it("resolves a registered handler by full name", () => {
    const registry = new ToolRegistryService();
    const tool = makeTool("read");
    registry.register(tool);
    assert.equal(registry.resolve("read"), tool);
  });

  it("keeps the last handler on a duplicate name (single entry)", () => {
    const registry = new ToolRegistryService();
    const first = makeTool("write", "first");
    const second = makeTool("write", "second");
    registry.register(first);
    registry.register(second);
    assert.equal(registry.resolve("write"), second);
    assert.deepEqual(registry.names(), ["write"]);
  });

  it("lists prompt definitions in registration order", () => {
    const registry = new ToolRegistryService();
    const read = makeTool("read");
    const write = makeTool("write");
    registry.registerAll([read, write]);
    assert.deepEqual(registry.listForPrompt(), [read.definition, write.definition]);
  });

  it("answers null for an unknown name", () => {
    const registry = new ToolRegistryService();
    registry.register(makeTool("read"));
    assert.equal(registry.resolve("nope"), null);
  });

  it("names every registered full name", () => {
    const registry = new ToolRegistryService();
    registry.registerAll([makeTool("read"), makeTool("git.recon")]);
    assert.deepEqual(registry.names(), ["read", "git.recon"]);
  });

  it("starts empty", () => {
    const registry = new ToolRegistryService();
    assert.deepEqual(registry.names(), []);
    assert.deepEqual(registry.listForPrompt(), []);
    assert.deepEqual(registry.listViews(), []);
  });
});

describe("ToolRegistryService views", () => {
  /** The eight MVP handlers the tools bootstrap registers. */
  const HANDLERS: Array<string> = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "shell",
    "patch",
    "todo",
  ];

  it("projects eight handlers into eight native views in registration order", () => {
    const registry = new ToolRegistryService();
    registry.registerAll(HANDLERS.map((name) => makeTool(name)));
    const views: Array<ToolView> = registry.listViews();
    assert.equal(views.length, 8);
    assert.deepEqual(
      views.map((view) => view.id),
      HANDLERS.map((name) => `native:${name}`),
    );
    assert.deepEqual(
      views.map((view) => view.title),
      HANDLERS,
    );
    for (const view of views) {
      assert.deepEqual(view.inputSchema, { type: "object" });
    }
  });

  it("keeps read-only native views non-mutating and write tools mutating", () => {
    const registry = new ToolRegistryService();
    registry.registerAll(HANDLERS.map((name) => makeTool(name)));
    const flags: Record<string, boolean> = {};
    for (const view of registry.listViews()) flags[view.id] = isMutatingToolView(view);

    assert.equal(flags["native:read"], false);
    assert.equal(flags["native:glob"], false);
    assert.equal(flags["native:grep"], false);
    assert.equal(flags["native:todo"], false);
    assert.equal(flags["native:write"], true);
    assert.equal(flags["native:edit"], true);
    assert.equal(flags["native:patch"], true);
    assert.equal(flags["native:shell"], true);
  });

  it("toolViewsFromDefinitions preserves order and copies the schema", () => {
    const views = toolViewsFromDefinitions([
      { name: "read", description: "read a file", inputSchema: { type: "object" } },
      { name: "git.recon", description: "git recon", inputSchema: { type: "object" } },
    ]);
    assert.deepEqual(views, [
      {
        id: "native:read",
        title: "read",
        description: "read a file",
        inputSchema: { type: "object" },
      },
      {
        id: "native:git.recon",
        title: "git.recon",
        description: "git recon",
        inputSchema: { type: "object" },
      },
    ]);
  });
});

function main(): void {
  for (const item of cases) {
    item.run();
    console.log(`ok ${item.name}`);
  }
  console.log(`done ${cases.length}`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
