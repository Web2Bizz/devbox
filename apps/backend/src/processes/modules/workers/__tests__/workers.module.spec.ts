import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { WorkspacePathService } from "../../../../common/storage/workspace-path.service";
import { RunsModule } from "../../runs/runs.module";
import { RunsClaimLoop } from "../modules/claim-loop";
import { ExecutorRegistry } from "../modules/executor";
import { RunWorktreeService } from "../modules/git";
import { ModelGateway, StubModelGateway } from "../modules/model-gateway";
import { SandboxProvider } from "../modules/sandbox";
import { SkillLoader } from "../modules/skills";
import { McpToolSource, ToolRegistry } from "../modules/tool-registry";
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

  it("imports the runs domain (journal/step repository)", () => {
    assert.deepEqual(meta<Array<unknown>>(MODULE_METADATA.IMPORTS), [RunsModule]);
  });

  it("registers the run engine providers", () => {
    const providers = meta<Array<unknown>>(MODULE_METADATA.PROVIDERS);
    assert.deepEqual(providers, [
      WorkspacePathService,
      RunWorktreeService,
      ToolRegistry,
      SkillLoader,
      { provide: ModelGateway, useClass: StubModelGateway },
      ExecutorRegistry,
      SandboxProvider,
      McpToolSource,
      RunsClaimLoop,
    ]);
  });

  it("exposes no controllers and no exports", () => {
    assert.equal(meta<Array<unknown>>(MODULE_METADATA.CONTROLLERS), undefined);
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
