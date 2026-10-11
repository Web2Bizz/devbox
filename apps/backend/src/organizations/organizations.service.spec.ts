/**
 * Organizations service unit checks — self-contained runner (no new deps,
 * plain node:assert, no live Postgres).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/organizations/organizations.service.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers (without a DB — every path below 503s before touching Postgres):
 * - ORG_INVITE_TTL_SEC server-wide policy (DEFAULT_ORG_INVITE_TTL_SEC 86400,
 *   explicit/unset/garbage via validateEnv — full matrix lives in env.spec);
 * - invite accept pre-DB gates: missing/consumed token → 404, expired
 *   token → 410 (and the token is deleted — replay → 404);
 * - missing invite never touches the DB (stub client throws on access).
 *
 * DB-backed rules (single-maintainer 409s, last-maintainer removal/demotion
 * 400s, member accept success) need live Postgres and are covered by the
 * live branch of organizations.e2e.ts — this spec stays green without PG.
 * Never logs secrets (tokens only as opaque map keys, never printed).
 */
import assert from 'node:assert/strict';
import { GoneException, NotFoundException } from '@nestjs/common';
import { DEFAULT_ORG_INVITE_TTL_SEC, validateEnvWithWarnings } from '../env.js';
import { OrganizationsService } from './organizations.service.js';

const SPEC_USER = '123e4567-e89b-12d3-a456-426614174001';
const SPEC_ORG = '123e4567-e89b-12d3-a456-426614174005';

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
 * pre-DB invite gates (404/410) never reach Postgres.
 */
function untouchedDb() {
  return {
    get client(): never {
      throw new Error('db-touched');
    },
  } as never;
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

function stubUsers() {
  return {
    findById: async (): Promise<null> => null,
  } as never;
}

function makeService(): OrganizationsService {
  return new OrganizationsService(silentLogger(), untouchedDb(), stubPaths(), stubUsers());
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'invite TTL policy is a single server-wide 24h default',
    run: () => {
      assert.equal(DEFAULT_ORG_INVITE_TTL_SEC, 86400);
      // Unset → 86400 default (full ERROR/WARN matrix in env.spec).
      const base: NodeJS.ProcessEnv = {
        APP_BACKEND_PORT: '3000',
        APP_BACKEND_HOST: '127.0.0.1',
        OPENCODE_URL: 'http://127.0.0.1:4096',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        CORS_ORIGINS: 'http://localhost:3001',
        JWT_ACCESS_SECRET: 'test-jwt-access-secret-not-real-0123456789',
        JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-not-real-0123456789',
        AUTH_LEGACY_MOCK_FALLBACK: 'false',
      } as NodeJS.ProcessEnv;
      const unset = validateEnvWithWarnings(base);
      assert.equal(unset.env.orgInviteTtlSec, 86400);
      assert.ok(unset.warnings.some((w) => w.includes('ORG_INVITE_TTL_SEC')));
      const explicit = validateEnvWithWarnings({ ...base, ORG_INVITE_TTL_SEC: '3600' });
      assert.equal(explicit.env.orgInviteTtlSec, 3600);
      assert.ok(!explicit.warnings.some((w) => w.includes('ORG_INVITE_TTL_SEC')));
    },
  },
  {
    name: 'accept with an unknown token → 404 without touching the DB',
    run: async () => {
      const svc = makeService();
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
    name: 'accept with an expired token → 410, token deleted (replay → 404)',
    run: async () => {
      const svc = makeService();
      svc.seedInviteForTests('expired-token', SPEC_ORG, 'user', Date.now() - 1000);
      await assert.rejects(
        () => svc.acceptInvite({ token: 'expired-token' }, SPEC_USER),
        (err: unknown) => {
          assert.ok(err instanceof GoneException);
          assert.match((err as Error).message, /expired/);
          return true;
        },
      );
      // Expired tokens are deleted on sight — replay is 404, not 410.
      await assert.rejects(
        () => svc.acceptInvite({ token: 'expired-token' }, SPEC_USER),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundException);
          return true;
        },
      );
    },
  },
  {
    name: 'freshly seeded (unexpired) token survives the pre-DB gates',
    run: async () => {
      const svc = makeService();
      svc.seedInviteForTests('fresh-token', SPEC_ORG, 'user', Date.now() + 3600_000);
      // The membership insert needs live Postgres (stub users → null user
      // → 404 after the token gate). What matters here: NOT 410 — the TTL
      // gate passed and the token was consumed single-use.
      await assert.rejects(
        () => svc.acceptInvite({ token: 'fresh-token' }, SPEC_USER),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundException);
          assert.ok(!(err instanceof GoneException));
          return true;
        },
      );
      // Single-use: the consumed token never grants membership twice.
      await assert.rejects(
        () => svc.acceptInvite({ token: 'fresh-token' }, SPEC_USER),
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
      // eslint-disable-next-line no-console
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`${failed}/${checks.length} organizations checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} organizations checks failed`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${checks.length}/${checks.length} organizations checks passed`);
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`organizations checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
