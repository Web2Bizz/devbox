import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { ReposModule } from "../modules/repos/repos.module";
import { WorkspacesModule } from "../modules/workspaces/workspaces.module";
import { RepositoryModule } from "../repository.module";

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
  return Reflect.getMetadata(key, RepositoryModule) as T | undefined;
}

describe("RepositoryModule metadata", () => {
  it("is an exported class named RepositoryModule", () => {
    assert.equal(typeof RepositoryModule, "function");
    assert.equal(RepositoryModule.name, "RepositoryModule");
  });

  it("imports ReposModule and WorkspacesModule", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.IMPORTS), [
      ReposModule,
      WorkspacesModule,
    ]);
  });

  it("re-exports both nested modules for the projects domain", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.EXPORTS), [
      ReposModule,
      WorkspacesModule,
    ]);
  });

  it("owns no controllers and no providers of its own", () => {
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
  console.log(`\n${cases.length - failed}/${cases.length} repository module checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`repository module checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
