import "reflect-metadata";
import assert from "node:assert/strict";
import { GUARDS_METADATA } from "@nestjs/common/constants";
const API_SECURITY_METADATA = "swagger/apiSecurity";
import { JwtAuthGuard } from "../../../../../../auth/jwt-auth.guard";
import { WorkflowsController } from "../workflows.controller";

type Case = { name: string; run: () => Promise<void> | void };

const cases: Array<Case> = [];
let currentSuite: string = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

function guardsOf(target: object): Array<unknown> {
  return (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as Array<unknown>;
}

function handlerNames(): Array<string> {
  return Object.getOwnPropertyNames(WorkflowsController.prototype).filter(
    (name) => name !== "constructor",
  );
}

function handler(name: string): object {
  return (WorkflowsController.prototype as unknown as Record<string, object>)[name];
}

function securityOf(target: object): Array<Record<string, unknown>> {
  return (Reflect.getMetadata(API_SECURITY_METADATA, target) ?? []) as Array<
    Record<string, unknown>
  >;
}

function hasBearerAuth(target: object): boolean {
  return securityOf(target).some((requirement) =>
    Object.prototype.hasOwnProperty.call(requirement, "bearer"),
  );
}

describe("WorkflowsController is Bearer-guarded", () => {
  it("applies JwtAuthGuard on the controller or on every public handler", () => {
    const classGuards = guardsOf(WorkflowsController);
    const classGuarded = classGuards.includes(JwtAuthGuard);
    const names = handlerNames();
    assert.ok(names.length > 0, "expected public handlers");
    for (const name of names) {
      const guarded = classGuarded || guardsOf(handler(name)).includes(JwtAuthGuard);
      assert.ok(guarded, `handler ${name} is not guarded by JwtAuthGuard`);
    }
  });

  it("documents Bearer auth on the controller or on every public handler", () => {
    const classAuth = hasBearerAuth(WorkflowsController);
    for (const name of handlerNames()) {
      const authorized = classAuth || hasBearerAuth(handler(name));
      assert.ok(authorized, `handler ${name} is not marked with @ApiBearerAuth`);
    }
  });
});

async function main(): Promise<void> {
  let failed: number = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`workflows controller security checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
