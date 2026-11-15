import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { organizationMembers, organizations } from "@common/db/schema";
import { OrganizationsGuard } from "../organizations.guard";

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

const ORG_ID = "123e4567-e89b-12d3-a456-426614174005";
const USER_ID = "123e4567-e89b-12d3-a456-426614174001";

const ORG_ROW = {
  id: ORG_ID,
  name: "rush",
  description: null,
  ownerId: USER_ID,
  isPrivate: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function silentLogger() {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as ConstructorParameters<typeof OrganizationsGuard>[0];
}

function untouchedDb() {
  return {
    get client(): never {
      throw new Error("db-touched");
    },
    executeRead: async (): Promise<never> => {
      throw new Error("db-touched");
    },
  } as never;
}

/** executeRead passthrough — runs the read once (no retry), like a closed breaker. */
function passthroughRead(
  _operation: string,
  read: (attempt: number) => Promise<unknown>,
): Promise<unknown> {
  return read(1);
}

function fakeDb(orgRows: Array<unknown>, memberRows: Array<unknown>) {
  const rowsFor = (table: unknown) =>
    table === organizations
      ? orgRows
      : table === organizationMembers
        ? memberRows
        : [];
  const client = {
    select: () => ({
      from: (table: unknown) => {
        const builder = {
          innerJoin: () => builder,
          where: () => ({ limit: async () => rowsFor(table) }),
        };
        return builder;
      },
    }),
  };
  return {
    get client() {
      return client as never;
    },
    executeRead: passthroughRead,
  } as never;
}

function fakeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function request(method: string, user?: unknown): Record<string, unknown> {
  const req: Record<string, unknown> = {
    method,
    params: { id: ORG_ID },
    correlationId: "cid-fail-closed",
  };
  if (user !== undefined) req.user = user;
  return req;
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

describe("OrganizationsGuard is fail-closed without identity", () => {
  it("GET with an org id and no user → 401 before touching the DB", async () => {
    const guard = new OrganizationsGuard(silentLogger(), untouchedDb());
    await assert.rejects(
      async () => guard.canActivate(fakeContext(request("GET"))),
      isUnauthorized,
    );
  });

  it("POST with an org id and no user → 401 before touching the DB", async () => {
    const guard = new OrganizationsGuard(silentLogger(), untouchedDb());
    await assert.rejects(
      async () => guard.canActivate(fakeContext(request("POST"))),
      isUnauthorized,
    );
  });

  it("malformed identity → 401, never true", async () => {
    const guard = new OrganizationsGuard(silentLogger(), untouchedDb());
    await assert.rejects(
      async () => guard.canActivate(fakeContext(request("GET", { id: "" }))),
      isUnauthorized,
    );
    await assert.rejects(
      async () => guard.canActivate(fakeContext(request("DELETE", null))),
      isUnauthorized,
    );
  });

  it("GET with a member identity still passes (regression)", async () => {
    const guard = new OrganizationsGuard(
      silentLogger(),
      fakeDb([ORG_ROW], [{ orgId: ORG_ID, userId: USER_ID, role: "user" }]),
    );
    assert.equal(
      await guard.canActivate(
        fakeContext(request("GET", { id: USER_ID, email: null, mock: false })),
      ),
      true,
    );
  });

  it("POST with a plain member still gets 403 (regression)", async () => {
    const guard = new OrganizationsGuard(
      silentLogger(),
      fakeDb([ORG_ROW], [{ orgId: ORG_ID, userId: USER_ID, role: "user" }]),
    );
    await assert.rejects(
      async () =>
        guard.canActivate(
          fakeContext(request("POST", { id: USER_ID, email: null, mock: false })),
        ),
      (err: unknown) => err instanceof ForbiddenException,
    );
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
  console.error(`organizations guard fail-closed checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
