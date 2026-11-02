import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { AgentsModule } from "../modules/agents/agents.module";
import { OpencodeModule } from "../modules/opencode/opencode.module";
import { SessionsModule } from "../modules/sessions/sessions.module";
import { WorkersModule } from "../../workers/workers.module";
import { AiModule } from "../ai.module";

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
  return Reflect.getMetadata(key, AiModule) as T | undefined;
}

describe("AiModule metadata", () => {
  it("is an exported class named AiModule", () => {
    assert.equal(typeof AiModule, "function");
    assert.equal(AiModule.name, "AiModule");
  });

  it("imports agents, workers, opencode and sessions modules", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.IMPORTS), [
      AgentsModule,
      WorkersModule,
      OpencodeModule,
      SessionsModule,
    ]);
  });

  it("re-exports only OpencodeModule", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.EXPORTS), [OpencodeModule]);
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
  console.log(`\n${cases.length - failed}/${cases.length} ai module checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`ai module checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
