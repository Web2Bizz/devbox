/**
 * Organizations service unit checks — self-contained runner (no new deps,
 * plain node:assert, no live Postgres).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/organizations/__tests__/organizations.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Wires the REAL extracted chain (phase 3, CoC v2) with stubs only for
 * Postgres/users/disk:
 *   OrgGuardService → MembersService → InvitesService → OrganizationsService
 * (invite accept is delegated OrganizationsService → InvitesService, so the
 * pre-DB gates below still prove the production path).
 *
 * Covers (without a live DB where noted):
 * - invite accept pre-DB gates: non-v7 token → 404 without touching the DB
 *   (stub client throws on access);
 * - valid v7 but unknown token → 404 via a mocked empty select (single-use
 *   DB rows, no TTL, no 410 — replay is also 404);
 * - email-bound invite mismatch → 404 (no enumeration).
 *
 * uuidv7 helper checks moved to
 * `utils/uuid-v7/__tests__/uuid-v7.spec.ts` (CoC v2: utils own their tests).
 *
 * DB-backed rules (single-maintainer 409s, last-maintainer 400s, member
 * accept success, link/unlink) need live Postgres and are covered by the
 * live branch of organizations.e2e.ts — this spec stays green without PG.
 * Never logs secrets (tokens only as opaque values, never printed).
 */
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { InvitesService } from '../invites.service';
import { MembersService } from '../members.service';
import { OrgGuardService } from '../org-guard.service';
import { OrganizationsService } from '../organizations.service';
import { randomUuidV7 } from '../utils/uuid-v7';

const SPEC_USER = '123e4567-e89b-12d3-a456-426614174001';

function silentLogger() {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as ConstructorParameters<typeof OrganizationsService>[0];
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
function mockDb(selectRows: unknown[] = []) {
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
 * Production shape: the guard, the two domain-root services and the org
 * service wired exactly as OrganizationsModule does (stubs only at the
 * Postgres/user/disk edges).
 */
function makeService(db: never, users: never): OrganizationsService {
  const guard = new OrgGuardService(silentLogger(), db);
  const members = new MembersService(silentLogger(), db, stubPaths(), users, guard);
  const invites = new InvitesService(silentLogger(), db, stubPaths(), users, guard);
  return new OrganizationsService(
    silentLogger(),
    db,
    stubPaths(),
    users,
    guard,
    members,
    invites,
  );
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'accept with a non-v7 token → 404 without touching the DB',
    run: async () => {
      const svc = makeService(untouchedDb(), stubUsers());
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
    name: 'accept with a valid v7 but unknown token → 404 (no TTL, no 410)',
    run: async () => {
      const svc = makeService(mockDb([]), stubUsers({ id: SPEC_USER, email: 'a@rush-code.local' }));
      const token = randomUuidV7();
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
      const token = randomUuidV7();
      const stored = {
        token,
        orgId: '123e4567-e89b-12d3-a456-426614174005',
        email: 'owner@rush-code.local',
        role: 'user',
        createdAt: new Date(),
      };
      const svc = makeService(
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
    console.error(`${failed}/${checks.length} organizations checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} organizations checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} organizations checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`organizations checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
