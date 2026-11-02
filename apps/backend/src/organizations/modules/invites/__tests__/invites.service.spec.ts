/**
 * Invites service unit checks — self-contained runner (no new deps,
 * plain node:assert, no live Postgres).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/organizations/modules/invites/__tests__/invites.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Wires the REAL invite chain (CoC §2: this spec lives in the owning nested
 * module's `__tests__/`) with stubs only for Postgres/users/disk:
 *   OrganizationsGuard → InvitesService
 * (no OrganizationsService/MembersService needed — the invite accept path
 * touches only the guard and the invites table).
 *
 * Covers (without a live DB where noted):
 * - invite accept pre-DB gates: non-v7 token → 404 without touching the DB
 *   (stub client throws on access);
 * - valid v7 but unknown token → 404 via a mocked empty select (single-use
 *   DB rows, no TTL, no 410 — replay is also 404);
 * - email-bound invite mismatch → 404 (no enumeration).
 *
 * DB-backed rules (single-maintainer 409s, last-maintainer 400s, member
 * accept success, link/unlink) need live Postgres and are covered by the
 * live branch of organizations.e2e.ts — this spec stays green without PG.
 * Never logs secrets (tokens only as opaque values, never printed).
 */
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { OrganizationsGuard } from '../../../organizations.guard';
import { InvitesService } from '../invites.service';

const SPEC_USER = '123e4567-e89b-12d3-a456-426614174001';

/** A well-formed v4 uuid — the invite token must be v7 instead. */
const V4_TOKEN = '123e4567-e89b-42d3-a456-426614174001';

function silentLogger() {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as ConstructorParameters<typeof InvitesService>[0];
}

/**
 * DbService stub whose client getter throws when touched — proves the
 * pre-DB invite gate (non-v7 → 404) never reaches Postgres.
 */
function untouchedDb() {
  return {
    get client(): never {
      throw new Error('db-touched');
    },
  } as never;
}

/** Minimal query-builder stub: select().from().where().limit() → rows. */
function mockDb(selectRows: Array<unknown> = []) {
  const client = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectRows,
        }),
      }),
    }),
  };
  return { get client() { return client as never; } } as never;
}

function stubPaths() {
  return {
    checkUuid: (value: unknown, label: string): string => {
      const raw = String(value ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
        throw new Error(`${label} must be a uuid`);
      }
      return raw;
    },
  } as never;
}

function stubUsers(user: { id: string; email: string } | null = null) {
  return {
    findById: async (): Promise<{ id: string; email: string } | null> => user,
  } as never;
}

/**
 * Production shape for this module: the shared guard plus InvitesService
 * wired exactly as InvitesModule does (stubs only at the Postgres/user/disk
 * edges).
 */
function makeInvites(db: never, users: never): InvitesService {
  const guard = new OrganizationsGuard(silentLogger(), db);
  return new InvitesService(silentLogger(), db, stubPaths(), users, guard);
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'accept with a non-v7 token → 404 without touching the DB',
    run: async () => {
      const svc = makeInvites(untouchedDb(), stubUsers());
      await assert.rejects(
        () => svc.acceptInvite({ token: 'no-such-token' }, SPEC_USER),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundException);
          assert.match((err as Error).message, /already used|not found/);
          return true;
        },
      );
      // The untouchedDb stub would throw 'db-touched' (not 404) on any
      // Postgres access — reaching this line proves the gate is pre-DB.
    },
  },
  {
    name: 'accept rejects a v4 uuid pre-DB → 404 (token must be v7)',
    run: async () => {
      const svc = makeInvites(untouchedDb(), stubUsers());
      await assert.rejects(
        () => svc.acceptInvite({ token: V4_TOKEN }, SPEC_USER),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundException);
          assert.match((err as Error).message, /already used|not found/);
          return true;
        },
      );
      // untouchedDb throws 'db-touched' on any Postgres access — reaching
      // this line proves the v7 shape gate runs before the lookup.
    },
  },
  {
    name: 'accept rejects a garbage token pre-DB → 404 (no DB access)',
    run: async () => {
      const svc = makeInvites(untouchedDb(), stubUsers());
      await assert.rejects(
        () => svc.acceptInvite({ token: 'no-such-token' }, SPEC_USER),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundException);
          assert.match((err as Error).message, /already used|not found/);
          return true;
        },
      );
    },
  },
  {
    name: 'accept rejects a base64url token pre-DB → 404 (no DB access)',
    run: async () => {
      const svc = makeInvites(untouchedDb(), stubUsers());
      await assert.rejects(
        () => svc.acceptInvite({ token: 'a'.repeat(44) }, SPEC_USER),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundException);
          assert.match((err as Error).message, /already used|not found/);
          return true;
        },
      );
    },
  },
  {
    name: 'accept with a valid v7 but unknown token → 404 (no TTL, no 410)',
    run: async () => {
      const svc = makeInvites(mockDb([]), stubUsers({ id: SPEC_USER, email: 'a@rush-code.local' }));
      const token = Bun.randomUUIDv7();
      await assert.rejects(
        () => svc.acceptInvite({ token }, SPEC_USER),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundException);
          assert.ok(!(err as Error).constructor.name.includes('Gone'));
          assert.match((err as Error).message, /already used|not found/);
          return true;
        },
      );
    },
  },
  {
    name: 'email-bound invite mismatch → 404 (no enumeration)',
    run: async () => {
      const token = Bun.randomUUIDv7();
      const stored = {
        token,
        orgId: '123e4567-e89b-12d3-a456-426614174005',
        email: 'owner@rush-code.local',
        role: 'user',
        createdAt: new Date(),
      };
      const svc = makeInvites(
        mockDb([stored]),
        stubUsers({ id: SPEC_USER, email: 'other@rush-code.local' }),
      );
      await assert.rejects(
        () => svc.acceptInvite({ token }, SPEC_USER),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundException);
          return true;
        },
      );
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
    console.error(`${failed}/${checks.length} invites checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} invites checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} invites checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`invites checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
