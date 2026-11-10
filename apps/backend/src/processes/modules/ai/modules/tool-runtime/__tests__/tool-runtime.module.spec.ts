/**
 * ToolRuntimeModule metadata checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/tool-runtime/__tests__/tool-runtime.module.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers the DI contract of the parent module: it re-exports both runtime
 * modules in declaration order and owns no controllers/providers of its own.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { ToolDispatchModule } from "../../tool-dispatch/tool-dispatch.module";
import { ToolRegistryModule } from "../../tool-registry/tool-registry.module";
import { ToolRuntimeModule } from "../tool-runtime.module";

type Case = { name: string; run: () => Promise<void> | void };

const cases: Array<Case> = [];
let currentSuite = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

function meta<T>(key: string): T | undefined {
  return Reflect.getMetadata(key, ToolRuntimeModule) as T | undefined;
}

describe("ToolRuntimeModule metadata", () => {
  it("is an exported class named ToolRuntimeModule", () => {
    assert.equal(typeof ToolRuntimeModule, "function");
    assert.equal(ToolRuntimeModule.name, "ToolRuntimeModule");
  });

  it("imports ToolRegistryModule then ToolDispatchModule", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.IMPORTS), [
      ToolRegistryModule,
      ToolDispatchModule,
    ]);
  });

  it("re-exports ToolRegistryModule then ToolDispatchModule", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.EXPORTS), [
      ToolRegistryModule,
      ToolDispatchModule,
    ]);
  });

  it("owns no controllers and no providers", () => {
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.CONTROLLERS), undefined);
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.PROVIDERS), undefined);
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} tool runtime module checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`tool runtime module checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
