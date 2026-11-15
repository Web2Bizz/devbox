/**
 * UsersService + UsersRepository unit checks — self-contained runner
 * (plain node:assert, no deps, no live Postgres).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/users/__tests__/users.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Wires the REAL service + repository; hashing goes through the real
 * `utils/password` util (needs the bun runtime) and only the Postgres edge is
 * stubbed (same convention as invites.service.spec.ts):
 * - createLocal duplicate (SQLSTATE 23505) → null (caller answers 409);
 * - createLocal stores a lowercased email (case-insensitive registration);
 * - createLocal maps the inserted row to ISO-8601 timestamps;
 * - any other DB failure → 503 EXTERNAL_UNAVAILABLE (dbUnavailable);
 * - findByEmail compares `lower(email) = lower($1)` (case-insensitive lookup
 *   for legacy mixed-case rows; asserted on the drizzle-built SQL);
 * - findById with a non-uuid key → null without touching the DB;
 * - findById with an unknown uuid → null;
 * - findById ECONNRESET (real DbService breaker+retry, stubbed drizzle edge):
 *   two transient failures then success (recovery without restart);
 * - findById persistent ECONNRESET → 503 EXTERNAL_UNAVAILABLE after exactly
 *   5 attempts (fallback, no crash — Retry-After 30 comes from the filter);
 * - findById non-retryable failure (22P02) → exactly 1 attempt;
 * - updateProfile trims, sets only the provided fields + updatedAt and maps
 *   the row back to ISO-8601.
 */
import assert from "node:assert/strict";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ExternalServiceError } from "@common/external/external-error";
import { DbService, type DbReadOptions } from "@common/db/db.service";
import { UsersRepository } from "../users.repository";
import { UsersService } from "../users.service";

const SPEC_USER_ID = "123e4567-e89b-12d3-a456-426614174001";
const CREATED_AT = new Date("2026-10-01T00:00:00.000Z");
const UPDATED_AT = new Date("2026-10-02T00:00:00.000Z");

function silentLogger() {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as ConstructorParameters<typeof UsersService>[1];
}

function makeService(db: never): UsersService {
  return new UsersService(new UsersRepository(db), silentLogger());
}

/** DbService stub whose client getter throws when touched — proves a pre-DB gate. */
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

/** insert().values().returning() → rows, or throws `error` (409 detection). */
function insertDb(
  outcome: { rows?: Array<unknown>; error?: unknown },
  capture?: (values: Record<string, unknown>) => void,
) {
  const client = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        capture?.(values);
        return {
          returning: async (): Promise<Array<unknown>> => {
            if (outcome.error !== undefined) throw outcome.error;
            return outcome.rows ?? [];
          },
        };
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

/** select().from().where(condition).limit() → rows; captures the condition. */
function selectDb(rows: Array<unknown>, capture?: (condition: SQL) => void) {
  const client = {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          capture?.(condition);
          return { limit: async (): Promise<Array<unknown>> => rows };
        },
      }),
    }),
  };
  return {
    get client() {
      return client as never;
    },
    executeRead: passthroughRead,
  } as never;
}

/** update().set(values).where(condition).returning() → rows; captures the values. */
function updateDb(
  rows: Array<unknown>,
  capture?: (values: Record<string, unknown>) => void,
) {
  const client = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        capture?.(values);
        return {
          where: () => ({ returning: async (): Promise<Array<unknown>> => rows }),
        };
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

const noSleep = (): Promise<void> => Promise.resolve();

/** pg transient-connection throw shaped like the node-postgres driver. */
function pgTransient(code: string): Error {
  return Object.assign(new Error(`read ${code}`), { code });
}

/** select().from().where().limit() following a script; repeats the last step. */
function flakySelectDb(
  script: Array<{ error?: unknown; rows?: Array<unknown> }>,
): { stub: unknown; getCalls: () => number } {
  let calls: number = 0;
  const stub: unknown = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (): Promise<Array<unknown>> => {
            calls += 1;
            const step: { error?: unknown; rows?: Array<unknown> } =
              script[Math.min(calls - 1, script.length - 1)];
            if (step.error !== undefined) throw step.error;
            return step.rows ?? [];
          },
        }),
      }),
    }),
  };
  const getCalls: () => number = () => calls;
  return { stub, getCalls };
}

/**
 * REAL DbService (breaker + 5-attempt retry) with a stubbed drizzle client:
 * proves the repository delegates reads to executeRead. The pool stays null
 * (DATABASE_URL/POSTGRES_* cleared around construction, then restored) so no
 * socket is ever opened; the injected client answers the SQL edge.
 */
function makeResilientService(stubClient: unknown): {
  service: UsersService;
  database: DbService;
} {
  const savedDatabaseUrl: string | undefined = process.env.DATABASE_URL;
  const savedUser: string | undefined = process.env.POSTGRES_USER;
  const savedDb: string | undefined = process.env.POSTGRES_DB;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_USER;
  delete process.env.POSTGRES_DB;
  try {
    const configStub = { get: (): undefined => undefined };
    const database: DbService = new DbService(
      configStub as never,
      silentLogger() as never,
    );
    Object.defineProperty(database, "client", {
      get: () => stubClient as never,
      configurable: true,
    });
    const service: UsersService = new UsersService(
      new UsersRepository(database as never),
      silentLogger(),
    );
    return { service, database };
  } finally {
    if (savedDatabaseUrl !== undefined)
      process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedUser !== undefined) process.env.POSTGRES_USER = savedUser;
    if (savedDb !== undefined) process.env.POSTGRES_DB = savedDb;
  }
}

/** Drizzle `users` row shape (Date objects — ISO conversion is the mapper's job). */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: SPEC_USER_ID,
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@rush-code.local",
    passwordHash: "stored-password-hash",
    provider: "local",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "createLocal duplicate (SQLSTATE 23505) → null (caller answers 409)",
    run: async () => {
      const service = makeService(
        insertDb({
          error: Object.assign(new Error("duplicate key value"), {
            code: "23505",
          }),
        }),
      );
      const created = await service.createLocal(
        {
          firstName: " Ada ",
          lastName: " Lovelace ",
          email: " ada@rush-code.local ",
          password: "s3cret-p4ss",
        },
        "cid-1",
      );
      assert.equal(created, null);
    },
  },
  {
    name: "createLocal stores a lowercased email (case-insensitive registration)",
    run: async () => {
      let inserted: Record<string, unknown> | undefined;
      const service = makeService(
        insertDb({ rows: [row()] }, (values) => {
          inserted = values;
        }),
      );
      await service.createLocal(
        {
          firstName: "Ada",
          lastName: "Lovelace",
          email: " ADA@Rush-Code.Local ",
          password: "s3cret-p4ss",
        },
        "cid-1",
      );
      assert.equal(inserted?.email, "ada@rush-code.local");
    },
  },
  {
    name: "createLocal success → StoredUser with ISO-8601 timestamps",
    run: async () => {
      const service = makeService(insertDb({ rows: [row()] }));
      const created = await service.createLocal(
        {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@rush-code.local",
          password: "s3cret-p4ss",
        },
        "cid-1",
      );
      assert.ok(created);
      assert.equal(created?.id, SPEC_USER_ID);
      assert.equal(created?.createdAt, CREATED_AT.toISOString());
      assert.equal(created?.updatedAt, UPDATED_AT.toISOString());
    },
  },
  {
    name: "createLocal non-unique DB failure → 503 EXTERNAL_UNAVAILABLE (db)",
    run: async () => {
      const service = makeService(insertDb({ error: new Error("connection refused") }));
      await assert.rejects(
        () =>
          service.createLocal(
            {
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@rush-code.local",
              password: "s3cret-p4ss",
            },
            "cid-1",
          ),
        (error: unknown) => {
          assert.ok(error instanceof ExternalServiceError);
          assert.equal((error as ExternalServiceError).code, "EXTERNAL_UNAVAILABLE");
          assert.equal((error as ExternalServiceError).service, "db");
          return true;
        },
      );
    },
  },
  {
    name: "findByEmail → lower(email) = lower($1) (case-insensitive lookup)",
    run: async () => {
      let condition: SQL | undefined;
      const service = makeService(
        selectDb([row({ email: "Ada@Rush-Code.local" })], (captured) => {
          condition = captured;
        }),
      );
      const found = await service.findByEmail("ADA@RUSH-CODE.LOCAL");
      assert.ok(found);
      assert.equal(found?.email, "Ada@Rush-Code.local");
      assert.equal(found?.createdAt, CREATED_AT.toISOString());
      assert.ok(condition, "the select must be filtered");
      const built = new PgDialect().sqlToQuery(condition as SQL);
      assert.equal(built.sql, 'lower("users"."email") = lower($1)');
      assert.deepEqual(built.params, ["ADA@RUSH-CODE.LOCAL"]);
    },
  },
  {
    name: "findById with a non-uuid key → null without touching the DB",
    run: async () => {
      const service = makeService(untouchedDb());
      assert.equal(await service.findById("alice", "cid-1"), null);
    },
  },
  {
    name: "findById with an unknown uuid → null",
    run: async () => {
      const service = makeService(selectDb([]));
      assert.equal(await service.findById(SPEC_USER_ID), null);
    },
  },
  {
    name: "updateProfile trims, sets only provided fields + updatedAt, maps ISO-8601",
    run: async () => {
      let values: Record<string, unknown> | undefined;
      const service = makeService(
        updateDb([row({ firstName: "Ada", lastName: "Lovelace" })], (captured) => {
          values = captured;
        }),
      );
      const updated = await service.updateProfile(SPEC_USER_ID, {
        firstName: "  Ada  ",
        lastName: "   ",
      });
      assert.ok(updated);
      assert.equal(updated?.updatedAt, UPDATED_AT.toISOString());
      assert.ok(values, "the update must set values");
      assert.equal(values?.firstName, "Ada");
      assert.equal("lastName" in (values as Record<string, unknown>), false);
      assert.ok((values as { updatedAt?: unknown }).updatedAt instanceof Date);
    },
  },
  {
    name: "updateProfile with a non-uuid key → null without touching the DB",
    run: async () => {
      const service = makeService(untouchedDb());
      assert.equal(await service.updateProfile("alice", { firstName: "Ada" }), null);
    },
  },
  {
    name: "findById ECONNRESET retries then succeeds (recovery without restart)",
    run: async () => {
      const flaky = flakySelectDb([
        { error: pgTransient("ECONNRESET") },
        { error: pgTransient("ECONNRESET") },
        { rows: [row()] },
      ]);
      const { service } = makeResilientService(flaky.stub);
      const found = await service.findById(SPEC_USER_ID, "cid-r1", {
        jitter: false,
        sleep: noSleep,
      });
      assert.ok(found);
      assert.equal(found?.id, SPEC_USER_ID);
      assert.equal(flaky.getCalls(), 3);
    },
  },
  {
    name: "findById persistent ECONNRESET → 503 EXTERNAL_UNAVAILABLE (fallback, no crash)",
    run: async () => {
      const flaky = flakySelectDb([{ error: pgTransient("ECONNRESET") }]);
      const { service } = makeResilientService(flaky.stub);
      await assert.rejects(
        () =>
          service.findById(SPEC_USER_ID, "cid-r2", {
            jitter: false,
            sleep: noSleep,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ExternalServiceError);
          const typed: ExternalServiceError = error as ExternalServiceError;
          assert.equal(typed.code, "EXTERNAL_UNAVAILABLE");
          assert.equal(typed.service, "db");
          assert.equal(typed.httpStatus, 503);
          assert.equal(typed.isRetryable, true);
          return true;
        },
      );
      assert.equal(flaky.getCalls(), 5);
    },
  },
  {
    name: "findById non-retryable failure runs once then 503",
    run: async () => {
      const flaky = flakySelectDb([
        {
          error: Object.assign(new Error("invalid input syntax"), {
            code: "22P02",
          }),
        },
      ]);
      const { service } = makeResilientService(flaky.stub);
      await assert.rejects(() =>
        service.findById(SPEC_USER_ID, "cid-r3", {
          jitter: false,
          sleep: noSleep,
        }),
      );
      assert.equal(flaky.getCalls(), 1);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} users checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} users checks failed`);
  }
  console.log(`${checks.length}/${checks.length} users checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`users checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
