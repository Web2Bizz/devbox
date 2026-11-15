/**
 * db-circuit pure functions — no side effects, no DI, no logger ownership.
 *
 * Resilience core for Postgres DAL reads (DbService.executeRead owns the
 * mutable state; these helpers stay pure so specs assert transitions
 * without timers or live Postgres):
 * - explicit pg Pool tunables (no driver defaults — every value is stated);
 * - retry budget for idempotent reads (5 attempts, backoff+jitter via the
 *   shared withRetry core);
 * - pg transient-connection predicate (dropped socket / restarting server:
 *   ECONNRESET/ETIMEDOUT/EPIPE + refused/unreachable codes, SQLSTATE
 *   08xxx/57P0x/53300, "connection terminated" texts, walked through the
 *   drizzle `.cause` chain — the retryable class; everything else, incl.
 *   SQLSTATE 22P02/23505 and AbortError, is NOT this class);
 * - consecutive-failure circuit breaker (closed → open → half-open →
 *   closed) with a 30s cooldown that matches the Retry-After 30 the
 *   ApiErrorFilter already answers on 503s (wire contract unchanged).
 *
 * Decision record (context7, 2026-11-11): NestJS core has no breaker
 * primitive (interceptors only wrap the handler — the wrong layer for a
 * per-DAL-read guard that must not retry non-idempotent writes); Terminus
 * (@nestjs/terminus, not a repo dep) is health-indicators only
 * (TypeOrmHealthIndicator.pingCheck ≈ the SELECT 1 checkDb already owns,
 * via the custom HealthRegistry — no new surface needed); cockatiel is a
 * full Polly-style fit but a new external dep for ~80 lines of state
 * machine while the repo already owns withRetry (backoff+jitter +
 * idempotency guard) + ExternalServiceError + per-attempt log conventions.
 * Verdict: hand-rolled breaker reusing withRetry, zero new dependencies.
 */

/** Total attempts (first + retries) for one idempotent DAL read. */
export const DB_READ_MAX_ATTEMPTS: number = 5;

/** Consecutive failed read operations that trip the breaker open. */
export const DB_BREAKER_FAILURE_THRESHOLD: number = 5;

/**
 * Open-breaker cooldown ms before a half-open trial is allowed. Matches the
 * Retry-After 30 the filter answers on 503 EXTERNAL_UNAVAILABLE so the
 * client's back-off and the breaker's coincide (contract unchanged).
 */
export const DB_BREAKER_COOLDOWN_MS: number = 30000;

/** Explicit pg Pool tunables — every value stated, no driver defaults. */
export const DB_POOL_MAX: number = 10;
export const DB_POOL_IDLE_TIMEOUT_MS: number = 30000;
export const DB_POOL_CONNECTION_TIMEOUT_MS: number = 5000;
export const DB_POOL_KEEP_ALIVE: boolean = true;
export const DB_POOL_KEEP_ALIVE_INITIAL_DELAY_MS: number = 10000;

export type DbBreakerName = "closed" | "open" | "half-open";

export type DbBreakerState = {
  name: DbBreakerName;
  /** Consecutive failed read operations (reset on any success). */
  consecutiveFailures: number;
  /** Epoch ms when the breaker last opened (0 = never). */
  openedAtMs: number;
};

export type DbResilienceStats = {
  name: DbBreakerName;
  consecutiveFailures: number;
  attempts: number;
  retries: number;
  breakerOpens: number;
  shortCircuits: number;
  halfOpenProbes: number;
};

/** Initial breaker state (closed, zero counters). */
export function initialDbBreakerState(): DbBreakerState {
  const state: DbBreakerState = {
    name: "closed",
    consecutiveFailures: 0,
    openedAtMs: 0,
  };
  return state;
}

/** Node errno / pg driver codes that form the retryable connection class. */
export { PG_TRANSIENT_CODES, PG_TRANSIENT_MESSAGE_PARTS } from '@common/db/exceptions/pg-transient';
import { isPgTransientConnectionError as isPgTransientShared } from '@common/db/exceptions/pg-transient';

/**
 * True ONLY for the transient pg connection class (dropped socket /
 * refusing-or-restarting server, via `code`, message text, or any nested
 * `.cause` — drizzle wraps driver throws as `DrizzleQueryError { cause }`).
 * Single source lives in common/db/exceptions/pg-transient; here only a
 * back-compat re-export so existing imports keep working without дублей.
 * Used twice: as the withRetry predicate for idempotent DAL reads, and as
 * the uncaughtException keep-alive class in main.ts (a dropped pg socket
 * mid-flight must not crash the process — anything outside this class
 * still exits via process.exit(1)).
 */
export function isPgTransientConnectionError(error: unknown): boolean {
  return isPgTransientShared(error);
}

/**
 * Open-breaker fast path: true while the cooldown has not elapsed (the
 * caller short-circuits to 503 without touching Postgres). False when
 * closed, or when open-but-expired (the caller may run ONE half-open trial).
 */
export function shouldShortCircuit(
  state: DbBreakerState,
  nowMs: number,
): boolean {
  if (state.name !== "open") return false;
  return nowMs - state.openedAtMs < DB_BREAKER_COOLDOWN_MS;
}

/** True when an open breaker with an elapsed cooldown may run one trial. */
export function shouldHalfOpenProbe(
  state: DbBreakerState,
  nowMs: number,
): boolean {
  return state.name === "open" && !shouldShortCircuit(state, nowMs);
}

/**
 * Pure transition on a finished read operation. Success resets the failure
 * count and closes (half-open trial success → closed). Failure increments;
 * reaching the threshold opens (openedAtMs stamped for the cooldown).
 */
export function nextDbBreakerState(
  state: DbBreakerState,
  outcome: "success" | "failure",
  nowMs: number,
): DbBreakerState {
  if (outcome === "success") {
    const closed: DbBreakerState = {
      name: "closed",
      consecutiveFailures: 0,
      openedAtMs: 0,
    };
    return closed;
  }
  const consecutiveFailures: number = state.consecutiveFailures + 1;
  if (consecutiveFailures >= DB_BREAKER_FAILURE_THRESHOLD) {
    const opened: DbBreakerState = {
      name: "open",
      consecutiveFailures,
      openedAtMs: nowMs,
    };
    return opened;
  }
  const stillClosed: DbBreakerState = {
    name: "closed",
    consecutiveFailures,
    openedAtMs: state.openedAtMs,
  };
  return stillClosed;
}

/**
 * Enters half-open for exactly one trial (called only after
 * shouldHalfOpenProbe). The trial outcome goes back through
 * nextDbBreakerState (success → closed, failure → open again).
 */
export function enterHalfOpen(state: DbBreakerState): DbBreakerState {
  const halfOpen: DbBreakerState = {
    name: "half-open",
    consecutiveFailures: state.consecutiveFailures,
    openedAtMs: state.openedAtMs,
  };
  return halfOpen;
}
