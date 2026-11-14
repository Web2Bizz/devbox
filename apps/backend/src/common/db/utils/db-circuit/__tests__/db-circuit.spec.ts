/**
 * db-circuit checks — self-contained runner (plain node:assert, no live Postgres).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/common/db/utils/db-circuit/__tests__/db-circuit.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers:
 * - pg transient predicate (dropped socket / restarting server: codes,
 *   "connection terminated" texts, SQLSTATE 57P01/… — incl. the codeless
 *   `Connection terminated unexpectedly` that used to crash the process —
 *   walked through the drizzle `.cause` chain; the main.ts uncaughtException
 *   keep-alive class);
 * - explicit Pool tunables + 5-attempt read budget (no driver defaults);
 * - pure breaker transitions (closed → open → half-open → closed, re-open);
 * - DbService.executeRead: retry-then-recover, budget exhaustion, fast fail
 *   on non-retryable, open short-circuit without touching Postgres.
 */
import assert from "node:assert/strict";
import { ExternalServiceError } from "@common/external/external-error";
import { DbService } from "@common/db/db.service";
import {
  DB_BREAKER_COOLDOWN_MS,
  DB_BREAKER_FAILURE_THRESHOLD,
  DB_POOL_CONNECTION_TIMEOUT_MS,
  DB_POOL_IDLE_TIMEOUT_MS,
  DB_POOL_KEEP_ALIVE,
  DB_POOL_KEEP_ALIVE_INITIAL_DELAY_MS,
  DB_POOL_MAX,
  DB_READ_MAX_ATTEMPTS,
  enterHalfOpen,
  initialDbBreakerState,
  isPgTransientConnectionError,
  nextDbBreakerState,
  shouldHalfOpenProbe,
  shouldShortCircuit,
  type DbBreakerState,
} from "../db-circuit.util";

const noSleep = (): Promise<void> => Promise.resolve();

function silentLogger(): {
  debug: () => void;
  info: () => void;
  log: () => void;
  warn: () => void;
  error: () => void;
  fatal: () => void;
} {
  return {
    debug: (): void => {},
    info: (): void => {},
    log: (): void => {},
    warn: (): void => {},
    error: (): void => {},
    fatal: (): void => {},
  };
}

function pgError(code: string, message?: string): Error {
  return Object.assign(new Error(message ?? `read ${code}`), { code });
}

/** REAL DbService with the pool forced to null (no sockets, ever). */
function makeDb(): DbService {
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
    return database;
  } finally {
    if (savedDatabaseUrl !== undefined)
      process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedUser !== undefined) process.env.POSTGRES_USER = savedUser;
    if (savedDb !== undefined) process.env.POSTGRES_DB = savedDb;
  }
}

/** Fails `failures` times with `error`, then answers `value`; counts calls. */
function flakyRead<T>(
  error: unknown,
  failures: number,
  value: T,
): { read: (attempt: number) => Promise<T>; getCalls: () => number } {
  let calls: number = 0;
  const read: (attempt: number) => Promise<T> = async (
    _attempt: number,
  ): Promise<T> => {
    calls += 1;
    if (calls <= failures) throw error;
    return value;
  };
  const getCalls: () => number = () => calls;
  return { read, getCalls };
}

function openBreaker(nowMs: number): DbBreakerState {
  let state: DbBreakerState = initialDbBreakerState();
  for (let i: number = 0; i < DB_BREAKER_FAILURE_THRESHOLD; i += 1) {
    state = nextDbBreakerState(state, "failure", nowMs);
  }
  return state;
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "pool tunables are explicit (no driver defaults)",
    run: () => {
      assert.equal(DB_POOL_MAX, 10);
      assert.equal(DB_POOL_IDLE_TIMEOUT_MS, 30000);
      assert.equal(DB_POOL_CONNECTION_TIMEOUT_MS, 5000);
      assert.equal(DB_POOL_KEEP_ALIVE, true);
      assert.equal(DB_POOL_KEEP_ALIVE_INITIAL_DELAY_MS, 10000);
    },
  },
  {
    name: "read budget is 5 attempts, cooldown matches Retry-After 30",
    run: () => {
      assert.equal(DB_READ_MAX_ATTEMPTS, 5);
      assert.equal(DB_BREAKER_FAILURE_THRESHOLD, 5);
      assert.equal(DB_BREAKER_COOLDOWN_MS, 30000);
    },
  },
  {
    name: "transient predicate: ECONNRESET/ETIMEDOUT/EPIPE true (code or message)",
    run: () => {
      assert.equal(isPgTransientConnectionError(pgError("ECONNRESET")), true);
      assert.equal(isPgTransientConnectionError(pgError("ETIMEDOUT")), true);
      assert.equal(isPgTransientConnectionError(pgError("EPIPE")), true);
      assert.equal(
        isPgTransientConnectionError(pgError("econnreset", "read ECONNRESET")),
        true,
      );
      assert.equal(
        isPgTransientConnectionError(new Error("read ECONNRESET")),
        true,
      );
      assert.equal(
        isPgTransientConnectionError(new Error("socket hang up")),
        true,
      );
    },
  },
  {
    name: "transient predicate: codeless pg drop + SQLSTATE shutdown + drizzle cause-chain true",
    run: () => {
      // Exact pg/lib/client.js string that crashed the process via
      // uncaughtException → throw (no `code` on it — message-only match).
      assert.equal(
        isPgTransientConnectionError(
          new Error("Connection terminated unexpectedly"),
        ),
        true,
      );
      // Postgres admin/crash shutdown + connection-exception class.
      for (const code of ["57P01", "57P02", "57P03", "08000", "08003", "08006"]) {
        assert.equal(
          isPgTransientConnectionError(pgError(code, "terminating connection")),
          true,
        );
      }
      // drizzle-orm wraps the driver throw as `DrizzleQueryError('Failed
      // query: …')` with the pg error on `.cause` — top-level carries
      // neither code nor signal text, so the predicate must unwrap.
      assert.equal(
        isPgTransientConnectionError(
          Object.assign(new Error("Failed query: select ... params: 1"), {
            cause: new Error("Connection terminated unexpectedly"),
          }),
        ),
        true,
      );
      assert.equal(
        isPgTransientConnectionError(
          Object.assign(new Error("Failed query: select ..."), {
            cause: pgError("57P01", "terminating connection due to administrator command"),
          }),
        ),
        true,
      );
      // ECONNREFUSED on a restarting Postgres is the same transient class.
      assert.equal(
        isPgTransientConnectionError(pgError("ECONNREFUSED", "connect ECONNREFUSED")),
        true,
      );
    },
  },
  {
    name: "transient predicate: SQLSTATE/AbortError/generic false (narrow class only)",
    run: () => {
      assert.equal(
        isPgTransientConnectionError(pgError("23505", "duplicate key")),
        false,
      );
      assert.equal(
        isPgTransientConnectionError(pgError("22P02", "invalid input syntax")),
        false,
      );
      assert.equal(
        isPgTransientConnectionError(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        ),
        false,
      );
      assert.equal(
        isPgTransientConnectionError(new Error("connection refused")),
        false,
      );
      assert.equal(isPgTransientConnectionError(null), false);
      assert.equal(isPgTransientConnectionError(undefined), false);
    },
  },
  {
    name: "breaker: 4 failures stay closed, 5th opens",
    run: () => {
      let state: DbBreakerState = initialDbBreakerState();
      for (let i: number = 0; i < 4; i += 1) {
        state = nextDbBreakerState(state, "failure", 1000);
        assert.equal(state.name, "closed");
      }
      assert.equal(state.consecutiveFailures, 4);
      state = nextDbBreakerState(state, "failure", 1000);
      assert.equal(state.name, "open");
      assert.equal(state.openedAtMs, 1000);
    },
  },
  {
    name: "breaker: short-circuit inside cooldown, half-open probe after",
    run: () => {
      const state: DbBreakerState = openBreaker(1000);
      assert.equal(shouldShortCircuit(state, 1000 + DB_BREAKER_COOLDOWN_MS - 1), true);
      assert.equal(shouldHalfOpenProbe(state, 1000 + DB_BREAKER_COOLDOWN_MS - 1), false);
      assert.equal(shouldShortCircuit(state, 1000 + DB_BREAKER_COOLDOWN_MS), false);
      assert.equal(shouldHalfOpenProbe(state, 1000 + DB_BREAKER_COOLDOWN_MS), true);
      assert.equal(shouldShortCircuit(initialDbBreakerState(), 999999), false);
    },
  },
  {
    name: "breaker: success closes (half-open trial → closed), failure re-opens",
    run: () => {
      const opened: DbBreakerState = openBreaker(1000);
      const trial: DbBreakerState = enterHalfOpen(opened);
      assert.equal(trial.name, "half-open");
      const closed: DbBreakerState = nextDbBreakerState(trial, "success", 40000);
      assert.equal(closed.name, "closed");
      assert.equal(closed.consecutiveFailures, 0);
      const retrial: DbBreakerState = enterHalfOpen(opened);
      const reopened: DbBreakerState = nextDbBreakerState(retrial, "failure", 40000);
      assert.equal(reopened.name, "open");
    },
  },
  {
    name: "executeRead: transient failures retry then recover (no restart)",
    run: async () => {
      const database: DbService = makeDb();
      const flaky = flakyRead(pgError("ECONNRESET"), 2, "row");
      const result: string = await database.executeRead("users.findById", flaky.read, {
        jitter: false,
        sleep: noSleep,
      });
      assert.equal(result, "row");
      assert.equal(flaky.getCalls(), 3);
      assert.equal(database.getBreakerState().name, "closed");
      const stats = database.getResilienceStats();
      assert.equal(stats.attempts, 3);
      assert.equal(stats.retries, 2);
    },
  },
  {
    name: "executeRead: persistent outage exhausts the 5-attempt budget",
    run: async () => {
      const database: DbService = makeDb();
      const flaky = flakyRead(pgError("ECONNRESET"), 99, "row");
      await assert.rejects(
        () =>
          database.executeRead("users.findById", flaky.read, {
            jitter: false,
            sleep: noSleep,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          return true;
        },
      );
      assert.equal(flaky.getCalls(), 5);
      assert.equal(database.getBreakerState().consecutiveFailures, 1);
    },
  },
  {
    name: "executeRead: non-retryable failure runs exactly once",
    run: async () => {
      const database: DbService = makeDb();
      const flaky = flakyRead(pgError("22P02", "invalid input syntax"), 99, "row");
      await assert.rejects(() =>
        database.executeRead("users.findById", flaky.read, {
          jitter: false,
          sleep: noSleep,
        }),
      );
      assert.equal(flaky.getCalls(), 1);
    },
  },
  {
    name: "executeRead: open breaker short-circuits without touching Postgres",
    run: async () => {
      const database: DbService = makeDb();
      const outage = flakyRead(pgError("ECONNRESET"), 99, "row");
      for (let i: number = 0; i < DB_BREAKER_FAILURE_THRESHOLD; i += 1) {
        await assert.rejects(() =>
          database.executeRead("users.findById", outage.read, {
            jitter: false,
            sleep: noSleep,
          }),
        );
      }
      assert.equal(database.getBreakerState().name, "open");
      let touched: boolean = false;
      await assert.rejects(
        () =>
          database.executeRead(
            "users.findById",
            async (): Promise<string> => {
              touched = true;
              return "row";
            },
            { jitter: false, sleep: noSleep },
          ),
        (error: unknown) => {
          assert.ok(error instanceof ExternalServiceError);
          assert.equal(
            (error as ExternalServiceError).code,
            "EXTERNAL_UNAVAILABLE",
          );
          assert.equal((error as ExternalServiceError).httpStatus, 503);
          return true;
        },
      );
      assert.equal(touched, false);
      assert.equal(database.getResilienceStats().shortCircuits, 1);
    },
  },
  {
    name: "executeRead: half-open trial after cooldown closes on success",
    run: async () => {
      const database: DbService = makeDb();
      let nowMs: number = 5000;
      const outage = flakyRead(pgError("EPIPE"), 99, "row");
      for (let i: number = 0; i < DB_BREAKER_FAILURE_THRESHOLD; i += 1) {
        await assert.rejects(() =>
          database.executeRead("users.findById", outage.read, {
            jitter: false,
            sleep: noSleep,
            now: () => nowMs,
          }),
        );
      }
      assert.equal(database.getBreakerState().name, "open");
      nowMs += DB_BREAKER_COOLDOWN_MS;
      const result: string = await database.executeRead(
        "users.findById",
        async () => "recovered",
        { jitter: false, sleep: noSleep, now: () => nowMs },
      );
      assert.equal(result, "recovered");
      assert.equal(database.getBreakerState().name, "closed");
      assert.equal(database.getResilienceStats().halfOpenProbes, 1);
    },
  },
  {
    name: "checkDb without pool answers down (never throws)",
    run: async () => {
      const database: DbService = makeDb();
      assert.equal(await database.checkDb(), "down");
    },
  },
];

async function main(): Promise<void> {
  let failed: number = 0;
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
    console.error(`${failed}/${checks.length} db-circuit checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} db-circuit checks failed`);
  }
  console.log(`${checks.length}/${checks.length} db-circuit checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`db-circuit checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});

