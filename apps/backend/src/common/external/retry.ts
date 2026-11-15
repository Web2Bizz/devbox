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
  isRetryableStatus,
  isTimeoutError,
} from './external-error';
import { isNetworkLikeError } from '../db/exceptions/pg-transient';
import { isAppError } from '../exceptions/app-error';

export const DEFAULT_MAX_ATTEMPTS: number = 3;
export const DEFAULT_BASE_DELAY_MS: number = 200;
export const DEFAULT_MAX_DELAY_MS: number = 2000;
/** Hard ceiling — never more attempts than this, even when misconfigured. */
export const HARD_MAX_ATTEMPTS: number = 10;

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
  sleep?: (milliseconds: number) => Promise<void>;
  /** Custom retry predicate (default: isRetryableError). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
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

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve: () => void) => setTimeout(resolve, milliseconds));
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
  const exponential: number = Math.min(
    baseDelayMs * 2 ** (attempt - 1),
    maxDelayMs,
  );
  if (!jitter) return exponential;
  return exponential / 2 + Math.random() * (exponential / 2);
}

export function resolveRetryOptions(
  options: RetryOptions = {},
): ResolvedRetryOptions {
  const maxAttempts: number = Math.min(
    Math.max(Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), 1),
    HARD_MAX_ATTEMPTS,
  );
  const baseDelayMs: number = Math.max(
    Math.floor(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS),
    0,
  );
  const maxDelayMs: number = Math.max(
    Math.floor(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS),
    baseDelayMs,
  );
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitter: options.jitter ?? true,
  };
}

/**
 * True when the failure is worth another attempt on an idempotent operation:
 * AppError.retryable (ExternalServiceError.isRetryable — единый базовый
 * класс), timeouts, HTTP 429/5xx carried as `{ status }` (Octokit-style),
 * pg transient drops + network-ish messages via единый
 * common/db/exceptions/pg-transient (isNetworkLikeError — коды, SQLSTATE
 * 08xxx/57P0x/53300, "connection terminated" через drizzle `.cause`-цепочку,
 * fetch failed/ENOTFOUND/socket hang up). 4xx (except 429) → false.
 */
export function isRetryableError(error: unknown): boolean {
  // Единый базовый класс: ExternalServiceError — наследник AppError, а
  // isRetryable-геттер возвращает то же retryable (отдельный instanceof-бранч
  // был дублем предиката — удалён, поведение то же).
  if (isAppError(error)) return error.retryable;
  if (isTimeoutError(error)) return true;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status: number = Number((error as { status?: unknown }).status);
    if (Number.isInteger(status)) {
      if (isRetryableStatus(status)) return true;
      if (status >= 400 && status <= 499) return false;
    }
  }
  return isNetworkLikeError(error);
}

/**
 * Runs `operation(attempt)` with the retry policy. Non-idempotent methods without
 * `allowNonIdempotentRetry` invoke `operation(1)` exactly once (no sleep, no loop).
 * Rejects with the last error (its `attempt` is NOT rewritten — factories
 * already stamp it; ExternalClient stamps per-attempt errors itself).
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitter,
  }: ResolvedRetryOptions = resolveRetryOptions(options);
  const sleep: (milliseconds: number) => Promise<void> =
    options.sleep ?? defaultSleep;
  const shouldRetry: (error: unknown, attempt: number) => boolean =
    options.shouldRetry ?? isRetryableError;

  if (!isIdempotentMethod(options.method) && !options.allowNonIdempotentRetry) {
    return operation(1);
  }

  let attempt: number = 1;
  for (;;) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error, attempt)) throw error;
      await sleep(computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitter));
      attempt += 1;
    }
  }
}
