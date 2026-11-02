/**
 * OrganizationsGuard unit checks — self-contained runner (no new deps, plain
 * node:assert, no Nest testing module, no live Postgres).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/organizations/__tests__/organizations.guard.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the HTTP face of the guard (`canActivate`) with a fake
 * ExecutionContext and a fake DbService/logger:
 * - no `params.id` → true, DB never touched (create/list/accept routes);
 * - GET + member row → true (member-only read);
 * - GET + no member row → 404 (existence is not leaked);
 * - POST + plain member row → 403 (maintainer-only mutation);
 * - POST + maintainer row → true.
 *
 * No secrets are ever logged (ids only, opaque).
 */
import assert from 'node:assert/strict';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { organizationMembers, organizations } from '../../common/db/schema';
import { OrganizationsGuard } from '../organizations.guard';

const ORG_ID = '123e4567-e89b-12d3-a456-426614174005';
const USER_ID = '123e4567-e89b-12d3-a456-426614174001';

const ORG_ROW = {
  id: ORG_ID,
  name: 'rush',
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

/**
 * DbService stub whose client getter throws when touched — proves a route
 * without an org id never reaches Postgres.
 */
function untouchedDb() {
  return {
    get client(): never {
      throw new Error('db-touched');
    },
  } as never;
}

/**
 * DbService stub keyed by table identity: `select().from(organizations)` →
 * orgRows, `select().from(organizationMembers)` → memberRows
 * (select().from().where().limit() is the only shape the guard uses).
 */
function fakeDb(orgRows: unknown[], memberRows: unknown[]) {
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
  return { get client() { return client as never; } } as never;
}

/** Fake ExecutionContext exposing exactly what the guard reads. */
function fakeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function request(
  method: string,
  opts: { params?: Record<string, string>; user?: Record<string, unknown> | null } = {},
): Record<string, unknown> {
  return {
    method,
    params: opts.params ?? { id: ORG_ID },
    user: opts.user === undefined ? { id: USER_ID, email: 'a@rush-code.local', mock: false } : opts.user,
    correlationId: 'cid-test',
  };
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'no params.id → true without touching the DB (create/list/accept)',
    run: async () => {
      const guard = new OrganizationsGuard(silentLogger(), untouchedDb());
      assert.equal(await guard.canActivate(fakeContext(request('POST', { params: {} }))), true);
      assert.equal(await guard.canActivate(fakeContext(request('GET', { params: {} }))), true);
      // untouchedDb would throw 'db-touched' on any Postgres access.
    },
  },
  {
    name: 'GET with a member row → true',
    run: async () => {
      const guard = new OrganizationsGuard(
        silentLogger(),
        fakeDb([ORG_ROW], [{ orgId: ORG_ID, userId: USER_ID, role: 'user' }]),
      );
      assert.equal(await guard.canActivate(fakeContext(request('GET'))), true);
    },
  },
  {
    name: 'GET with no member row → 404 (no existence leak)',
    run: async () => {
      const guard = new OrganizationsGuard(silentLogger(), fakeDb([ORG_ROW], []));
      await assert.rejects(
        () => guard.canActivate(fakeContext(request('GET'))),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundException);
          return true;
        },
      );
    },
  },
  {
    name: 'POST with a plain member → 403 (maintainer-only mutation)',
    run: async () => {
      const guard = new OrganizationsGuard(
        silentLogger(),
        fakeDb([ORG_ROW], [{ orgId: ORG_ID, userId: USER_ID, role: 'user' }]),
      );
      await assert.rejects(
        () => guard.canActivate(fakeContext(request('POST'))),
        (err: unknown) => {
          assert.ok(err instanceof ForbiddenException);
          return true;
        },
      );
    },
  },
  {
    name: 'POST with a maintainer → true',
    run: async () => {
      const guard = new OrganizationsGuard(
        silentLogger(),
        fakeDb([ORG_ROW], [{ orgId: ORG_ID, userId: USER_ID, role: 'maintainer' }]),
      );
      assert.equal(await guard.canActivate(fakeContext(request('POST'))), true);
      assert.equal(await guard.canActivate(fakeContext(request('PATCH'))), true);
      assert.equal(await guard.canActivate(fakeContext(request('DELETE'))), true);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} organizations.guard checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} organizations.guard checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} organizations.guard checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`organizations.guard checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
