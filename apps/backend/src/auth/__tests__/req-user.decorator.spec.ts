import "reflect-metadata";
import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { ReqUser } from "../req-user.decorator";

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

const IDENTITY = {
  id: "123e4567-e89b-12d3-a456-426614174001",
  email: "alice@example.com",
  mock: false,
};

type RouteArgEntry = {
  factory: (data: unknown, ctx: ExecutionContext) => unknown;
};

class ProbeController {
  handler(@ReqUser() _identity: unknown): void {}
}

function reqUserFactory(): RouteArgEntry["factory"] {
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    ProbeController,
    "handler",
  ) as Record<string, RouteArgEntry> | undefined;
  const entries = Object.values(metadata ?? {});
  const entry = entries[0];
  assert.ok(entry, "ReqUser parameter metadata was not registered");
  return entry.factory;
}

function fakeContext(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function isUnauthorized(err: unknown): boolean {
  assert.ok(
    err instanceof UnauthorizedException,
    `expected UnauthorizedException, got ${String(err)}`,
  );
  assert.equal(err.getStatus(), 401);
  const body = err.getResponse() as { code?: string };
  assert.equal(body.code, "unauthorized");
  return true;
}

describe("ReqUser is fail-closed", () => {
  it("rejects a request without user → 401 unauthorized", async () => {
    const factory = reqUserFactory();
    await assert.rejects(
      async () => factory(undefined, fakeContext({})),
      isUnauthorized,
    );
  });

  it("rejects null and malformed identities → 401 unauthorized", async () => {
    const factory = reqUserFactory();
    await assert.rejects(
      async () => factory(undefined, fakeContext({ user: null })),
      isUnauthorized,
    );
    await assert.rejects(
      async () => factory(undefined, fakeContext({ user: { id: "" } })),
      isUnauthorized,
    );
    await assert.rejects(
      async () => factory(undefined, fakeContext({ user: { id: 42 } })),
      isUnauthorized,
    );
  });

  it("rejects a missing request object → 401 unauthorized", async () => {
    const factory = reqUserFactory();
    await assert.rejects(
      async () => factory(undefined, fakeContext(undefined)),
      isUnauthorized,
    );
  });

  it("returns the attached identity unchanged", async () => {
    const factory = reqUserFactory();
    assert.deepEqual(factory(undefined, fakeContext({ user: IDENTITY })), IDENTITY);
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
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`req-user decorator checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
