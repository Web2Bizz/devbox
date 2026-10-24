/**
 * withRetry — bounded retry for outbound calls.
 *
 * Policy (spec):
 * - retry ONLY idempotent operations (GET/HEAD/OPTIONS by default) on
 *   retryable failures: HTTP 429 / 5xx, timeouts, network errors
 *   (see ExternalServiceError.isRetryable / isRetryableError).
 * - non-idempotent methods (POST/PUT/PATCH/DELETE) run EXACTLY once unless
 *   the caller passes `allowNonIdempotentRetry: true` explicitly.
 * - 4xx (except 429) never retry — fail fast.
 * - exponential backoff: baseDelayMs * 2^(attempt-1), capped at maxDelayMs,
 *   with equal-jitter (`jitter: true` → delay/2 + rand(delay/2)).
 * - defaults come from env (EXTERNAL_RETRY_*: 3 / 200ms / 2000ms) — see
 *   resolveRetryDefaults(); callers may override per call.
 */
import {
  ExternalServiceError,
  isRetryableStatus,
  isTimeoutError,
} from './external-error';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 200;
export const DEFAULT_MAX_DELAY_MS = 2000;
/** Hard ceiling — never more attempts than this, even when misconfigured. */
export const HARD_MAX_ATTEMPTS = 10;

/** Methods that must not be retried without an explicit opt-in flag. */
export const NON_IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

export type RetryOptions = {
  /** Total attempts including the first (1 = no retry). Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms (doubles per attempt). Default 200. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 2000. */
  maxDelayMs?: number;
  /** Equal-jitter the backoff (default true); false → deterministic (tests). */
  jitter?: boolean;
  /** HTTP method for the idempotency guard (default 'GET'). */
  method?: string;
  /**
   * Opt-in to retry POST/PUT/PATCH/DELETE (default false → exactly 1 attempt).
   * Pass true only for provably idempotent server-side operations.
   */
  allowNonIdempotentRetry?: boolean;
  /** Injected clock for tests (default: setTimeout-based). */
  sleep?: (ms: number) => Promise<void>;
  /** Custom retry predicate (default: isRetryableError). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
};

export type ResolvedRetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
};

/** True for GET/HEAD/OPTIONS (and anything outside the non-idempotent set). */
export function isIdempotentMethod(method?: string): boolean {
  return !NON_IDEMPOTENT_METHODS.has((method ?? 'GET').toUpperCase());
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pure backoff: exponential from `baseDelayMs`, capped at `maxDelayMs`.
 * `attempt` is the 1-based number of the attempt that just failed.
 * Equal jitter when `jitter` is true (uses Math.random — pass false in tests).
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  if (!jitter) return exponential;
  return exponential / 2 + Math.random() * (exponential / 2);
}

export function resolveRetryOptions(opts: RetryOptions = {}): ResolvedRetryOptions {
  const maxAttempts = Math.min(
    Math.max(Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), 1),
    HARD_MAX_ATTEMPTS,
  );
  const baseDelayMs = Math.max(Math.floor(opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS), 0);
  const maxDelayMs = Math.max(
    Math.floor(opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS),
    baseDelayMs,
  );
  return { maxAttempts, baseDelayMs, maxDelayMs, jitter: opts.jitter ?? true };
}

/**
 * True when the failure is worth another attempt on an idempotent operation:
 * ExternalServiceError.isRetryable, timeouts, HTTP 429/5xx carried as
 * `{ status }` (Octokit-style), or network-ish messages (fetch failed,
 * ECONNREFUSED, ENOTFOUND, socket hang up …). 4xx (except 429) → false.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ExternalServiceError) return err.isRetryable;
  if (isTimeoutError(err)) return true;
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = Number((err as { status?: unknown }).status);
    if (Number.isInteger(status)) {
      if (isRetryableStatus(status)) return true;
      if (status >= 400 && status <= 499) return false;
    }
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('fetch failed') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('eai_again') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('network')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Runs `fn(attempt)` with the retry policy. Non-idempotent methods without
 * `allowNonIdempotentRetry` invoke `fn(1)` exactly once (no sleep, no loop).
 * Rejects with the last error (its `attempt` is NOT rewritten — factories
 * already stamp it; ExternalClient stamps per-attempt errors itself).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitter } = resolveRetryOptions(opts);
  const sleep = opts.sleep ?? defaultSleep;
  const shouldRetry = opts.shouldRetry ?? isRetryableError;

  if (!isIdempotentMethod(opts.method) && !opts.allowNonIdempotentRetry) {
    return fn(1);
  }

  let attempt = 1;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) throw err;
      await sleep(computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitter));
      attempt += 1;
    }
  }
}
