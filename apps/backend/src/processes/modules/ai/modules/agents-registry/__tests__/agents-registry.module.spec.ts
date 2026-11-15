/**
 * AgentsRegistryModule metadata checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/agents-registry/__tests__/agents-registry.module.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers the DI contract: the module owns and exports the single registry
 * provider and imports nothing (mirrors tool-registry.module.spec.ts).
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { AgentsRegistryModule } from "../agents-registry.module";
import { AgentsRegistryService } from "../agents-registry.service";

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
  return Reflect.getMetadata(key, AgentsRegistryModule) as T | undefined;
}

describe("AgentsRegistryModule metadata", () => {
  it("is an exported class named AgentsRegistryModule", () => {
    assert.equal(typeof AgentsRegistryModule, "function");
    assert.equal(AgentsRegistryModule.name, "AgentsRegistryModule");
  });

  it("provides AgentsRegistryService", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.PROVIDERS), [AgentsRegistryService]);
  });

  it("exports AgentsRegistryService", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.EXPORTS), [AgentsRegistryService]);
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
  console.log(`\n${cases.length - failed}/${cases.length} agents registry module checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`agents registry module checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
