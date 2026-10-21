/**
 * Organizations service unit checks — self-contained runner (no new deps,
 * plain node:assert, no live Postgres).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/organizations/organizations.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers (without a live DB where noted):
 * - uuidv7 invite ids (randomUuidV7/isUuidV7: version/variant bits, shape,
 *   rejects v4/base64/garbage, time-ordered);
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
import {
  OrganizationsService,
  isUuidV7,
  randomUuidV7,
} from './organizations.service';

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

function makeService(db: never, users: never): OrganizationsService {
  return new OrganizationsService(silentLogger(), db, stubPaths(), users);
}

const V4 = '123e4567-e89b-12d3-a456-426614174001';

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'randomUuidV7 emits RFC 9562 v7 ids (version 7, variant 8-b, time-ordered)',
    run: () => {
      const a = randomUuidV7(Date.parse('2026-10-20T00:00:00.000Z'));
      const b = randomUuidV7(Date.parse('2026-10-20T00:00:01.000Z'));
      assert.ok(isUuidV7(a), `expected v7, got ${a}`);
      assert.ok(isUuidV7(b), `expected v7, got ${b}`);
      assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      // Time-ordered: later timestamp sorts later lexicographically.
      assert.ok(a < b, `expected ${a} < ${b}`);
      assert.ok(!isUuidV7(V4), 'v4 must not pass as v7');
      assert.ok(!isUuidV7('no-such-token'), 'garbage must not pass as v7');
      assert.ok(!isUuidV7('a'.repeat(44)), 'base64url must not pass as v7');
    },
  },
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
      const svc = makeService(mockDb([]), stubUsers({ id: SPEC_USER, email: 'a@devbox.local' }));
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
        email: 'owner@devbox.local',
        role: 'user',
        createdAt: new Date(),
      };
      const svc = makeService(
        mockDb([stored]),
        stubUsers({ id: SPEC_USER, email: 'other@devbox.local' }),
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
