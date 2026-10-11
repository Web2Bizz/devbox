/**
 * ExternalClient — shared outbound fetch: per-attempt timeout + bounded
 * retry + per-attempt logging.
 *
 * - Timeout: AbortController per attempt (`timeoutMs`, default from
 *   REQUEST_TIMEOUT_MS) → EXTERNAL_TIMEOUT on abort.
 * - Retry: withRetry (GET/idempotent + 429/5xx/timeout/network; POST/… run
 *   once unless `allowNonIdempotentRetry: true`). Retryable HTTP statuses
 *   (429/5xx) are drained and retried; the LAST response is returned when
 *   attempts are exhausted (callers decide fallback vs error) — only
 *   network/timeout exhaustion throws ExternalServiceError.
 * - Logs (via AppLogger, correlationId-bound, secrets never logged — no
 *   URL/query/headers/bodies, only service/operation/attempt/latencyMs/
 *   status): debug on start + success, warn on retryable attempt failure,
 *   error on final failure.
 */
import { Injectable } from '@nestjs/common';
import { AppLogger } from '../app-logger.service.js';
import { validateEnv } from '../../env.js';
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
  isRetryableStatus,
  timeoutError,
} from './external-error.js';
import { DEFAULT_MAX_DELAY_MS, withRetry, type RetryOptions } from './retry.js';

export const FALLBACK_REQUEST_TIMEOUT_MS = 10000;

export interface ExternalFetchOptions {
  /** Logical upstream, e.g. 'opencode' | 'github'. */
  service: string;
  /** Logical operation, e.g. 'getSession' | 'sendChat'. */
  operation: string;
  /** Per-attempt budget ms (default: REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Retry tuning (method is inferred from init when omitted). */
  retry?: RetryOptions;
  /** Explicit opt-in to retry POST/PUT/PATCH/DELETE. */
  allowNonIdempotentRetry?: boolean;
  /** Traced through every attempt log line. */
  correlationId?: string;
}

function resolveTimeoutMs(explicit?: number): number {
  if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0) {
    return explicit;
  }
  try {
    return validateEnv(process.env).requestTimeoutMs;
  } catch {
    // readonly-исключение: тюнинг таймаута чтения (не путь записи) — дефолт при
    // невалидном env; boot-валидация при этом всё равно fail-fast через
    // ConfigModule.validate, запросы не маскируются под успех (503/throw выше).
    return FALLBACK_REQUEST_TIMEOUT_MS;
  }
}

function resolveRetryDefaults(): { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } {
  try {
    const env = validateEnv(process.env);
    return {
      maxAttempts: env.externalRetryMaxAttempts,
      baseDelayMs: env.externalRetryBaseDelayMs,
      maxDelayMs: env.externalRetryMaxDelayMs,
    };
  } catch {
    // readonly-исключение: см. resolveTimeoutMs — дефолты ретрая чтения.
    return {
      maxAttempts: 3,
      baseDelayMs: 200,
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
    };
  }
}

@Injectable()
export class ExternalClient {
  constructor(private readonly logger: AppLogger = new AppLogger('ExternalClient')) {}

  /**
   * GET/… with retry; POST/PUT/PATCH/DELETE exactly once unless
   * `allowNonIdempotentRetry` is true. Resolves with the upstream Response
   * (even non-ok — callers check `.ok`); throws ExternalServiceError only
   * when no usable response exists (network/timeout exhaustion).
   */
  async fetchWithRetry(
    url: string,
    init: RequestInit = {},
    opts: ExternalFetchOptions,
  ): Promise<Response> {
    const { service, operation, correlationId } = opts;
    const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
    const defaults = resolveRetryDefaults();
    const method = (init.method ?? 'GET').toUpperCase();
    const retryOpts: RetryOptions = {
      maxAttempts: defaults.maxAttempts,
      baseDelayMs: defaults.baseDelayMs,
      maxDelayMs: defaults.maxDelayMs,
      ...opts.retry,
      method: opts.retry?.method ?? method,
      allowNonIdempotentRetry:
        opts.retry?.allowNonIdempotentRetry ?? opts.allowNonIdempotentRetry ?? false,
    };

    const startedAt = Date.now();
    this.logger.debug(
      `[external] start service=${service} operation=${operation} method=${method}`,
      correlationId,
    );

    try {
      return await withRetry(
        async (attempt) => {
          const attemptStartedAt = Date.now();
          let res: Response;
          try {
            res = await this.doFetch(url, init, timeoutMs);
          } catch (err) {
            throw this.classifyTransportError(service, operation, attempt, err);
          }
          const latencyMs = Date.now() - attemptStartedAt;
          if (isRetryableStatus(res.status)) {
            // Drain before retry so the socket can be reused; the body is
            // intentionally discarded (fixed messages only, never logged).
            await res.arrayBuffer().catch(() => null);
            const retryable = fromStatus(service, operation, res.status, attempt);
            this.logger.warn(
              `[external] retry service=${service} operation=${operation} ` +
                `attempt=${attempt} status=${res.status} latencyMs=${latencyMs}`,
              correlationId,
            );
            throw retryable;
          }
          this.logger.debug(
            `[external] success service=${service} operation=${operation} ` +
              `attempt=${attempt} status=${res.status} latencyMs=${latencyMs}`,
            correlationId,
          );
          return res;
        },
        retryOpts,
      );
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      if (err instanceof ExternalServiceError) {
        this.logger.error(
          `[external] failure service=${service} operation=${operation} ` +
            `code=${err.code} attempt=${err.attempt} latencyMs=${latencyMs}`,
          correlationId,
        );
        throw err;
      }
      // Non-retryable 4xx normalization (fromStatus) or unexpected throw —
      // still logged with fixed fields only.
      const normalized = fromUnknown(service, operation, err, retryOpts.maxAttempts ?? 1);
      this.logger.error(
        `[external] failure service=${service} operation=${operation} ` +
          `code=${normalized.code} latencyMs=${latencyMs}`,
        correlationId,
      );
      throw normalized;
    }
  }

  /** Single-attempt fetch with an AbortController budget (no retry, no throw on HTTP status). */
  async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<Response> {
    const budget = resolveTimeoutMs(timeoutMs);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budget);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async doFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.fetchWithTimeout(url, init, timeoutMs);
  }

  private classifyTransportError(
    service: string,
    operation: string,
    attempt: number,
    err: unknown,
  ): ExternalServiceError {
    if (err instanceof ExternalServiceError) {
      err.attempt = attempt;
      return err;
    }
    if (
      typeof err === 'object' &&
      err !== null &&
      ((err as { name?: unknown }).name === 'AbortError' ||
        (err as { code?: unknown }).code === 'AbortError')
    ) {
      return timeoutError(service, operation, attempt, err);
    }
    return fromUnknown(service, operation, err, attempt);
  }
}
