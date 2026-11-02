import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { AiModule } from "../modules/ai/ai.module";
import { WorkersModule } from "../modules/workers/workers.module";
import { ProcessesModule } from "../processes.module";

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
  return Reflect.getMetadata(key, ProcessesModule) as T | undefined;
}

describe("ProcessesModule metadata", () => {
  it("is an exported class", () => {
    assert.equal(typeof ProcessesModule, "function");
    assert.equal(ProcessesModule.name, "ProcessesModule");
  });

  it("imports AiModule and WorkersModule", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.IMPORTS), [AiModule, WorkersModule]);
  });

  it("exports only AiModule", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.EXPORTS), [AiModule]);
  });

  it("registers no controllers and no providers of its own", () => {
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
  console.log(`\n${cases.length - failed}/${cases.length} processes module checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`processes module checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
