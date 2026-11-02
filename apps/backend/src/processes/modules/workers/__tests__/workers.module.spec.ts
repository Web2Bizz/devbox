import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { WorkersModule } from "../workers.module";

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
  return Reflect.getMetadata(key, WorkersModule) as T | undefined;
}

describe("WorkersModule metadata", () => {
  it("is an exported class named WorkersModule", () => {
    assert.equal(typeof WorkersModule, "function");
    assert.equal(WorkersModule.name, "WorkersModule");
  });

  it("is a scaffold with no imports", () => {
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.IMPORTS), undefined);
  });

  it("registers no controllers, providers or exports", () => {
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.CONTROLLERS), undefined);
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.PROVIDERS), undefined);
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.EXPORTS), undefined);
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
  console.log(`\n${cases.length - failed}/${cases.length} workers module checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`workers module checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
