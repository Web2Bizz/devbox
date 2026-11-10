/**
 * ToolRegistryModule metadata checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/tool-registry/__tests__/tool-registry.module.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers the DI contract: the module owns and exports the single registry
 * provider and imports nothing.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { ToolRegistryModule } from "../tool-registry.module";
import { ToolRegistryService } from "../tool-registry.service";

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
  return Reflect.getMetadata(key, ToolRegistryModule) as T | undefined;
}

describe("ToolRegistryModule metadata", () => {
  it("is an exported class named ToolRegistryModule", () => {
    assert.equal(typeof ToolRegistryModule, "function");
    assert.equal(ToolRegistryModule.name, "ToolRegistryModule");
  });

  it("provides ToolRegistryService", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.PROVIDERS), [ToolRegistryService]);
  });

  it("exports ToolRegistryService", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.EXPORTS), [ToolRegistryService]);
  });

  it("imports nothing and owns no controllers", () => {
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.IMPORTS), undefined);
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
  console.log(`\n${cases.length - failed}/${cases.length} tool registry module checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`tool registry module checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
