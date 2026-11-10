/**
 * ToolDispatchModule metadata checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/tool-dispatch/__tests__/tool-dispatch.module.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers the DI contract: the dispatcher imports the registry module, owns and
 * exports its single service, and has no controllers.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { ToolRegistryModule } from "../../tool-registry/tool-registry.module";
import { ToolDispatchModule } from "../tool-dispatch.module";
import { ToolDispatchService } from "../tool-dispatch.service";

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
  return Reflect.getMetadata(key, ToolDispatchModule) as T | undefined;
}

describe("ToolDispatchModule metadata", () => {
  it("is an exported class named ToolDispatchModule", () => {
    assert.equal(typeof ToolDispatchModule, "function");
    assert.equal(ToolDispatchModule.name, "ToolDispatchModule");
  });

  it("imports ToolRegistryModule", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.IMPORTS), [ToolRegistryModule]);
  });

  it("provides ToolDispatchService", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.PROVIDERS), [ToolDispatchService]);
  });

  it("exports ToolDispatchService", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.EXPORTS), [ToolDispatchService]);
  });

  it("owns no controllers", () => {
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.CONTROLLERS), undefined);
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
  console.log(`\n${cases.length - failed}/${cases.length} tool dispatch module checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`tool dispatch module checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
