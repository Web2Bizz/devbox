import "reflect-metadata";
import assert from "node:assert/strict";
import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from "@nestjs/common/constants";
import { DockerModule } from "../modules/docker/docker.module";
import { NpmModule } from "../modules/npm/npm.module";
import { RegistriesModule } from "../registries.module";

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
  return Reflect.getMetadata(key, RegistriesModule) as T | undefined;
}

describe("RegistriesModule metadata", () => {
  it("is an exported class named RegistriesModule", () => {
    assert.equal(typeof RegistriesModule, "function");
    assert.equal(RegistriesModule.name, "RegistriesModule");
  });

  it("imports DockerModule and NpmModule", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.IMPORTS), [DockerModule, NpmModule]);
  });

  it("re-exports both registry modules", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.EXPORTS), [DockerModule, NpmModule]);
  });

  it("registers no controllers of its own", () => {
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.CONTROLLERS), undefined);
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.PROVIDERS), undefined);
  });

  it("is a global module", () => {
    assert.equal(Reflect.getMetadata(GLOBAL_MODULE_METADATA, RegistriesModule), true);
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
  console.log(`\n${cases.length - failed}/${cases.length} registries module checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`registries module checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
