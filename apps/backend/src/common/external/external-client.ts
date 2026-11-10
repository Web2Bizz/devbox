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
 *   status/code): debug on start + success, warn on retryable attempt
 *   failure, error on final failure. Normal-path warn/error are one-liners
 *   without stack (`\n at ` never appears there); diagnostics (cause/stack)
 *   go to debug only, sanitized by AppLogger (URL credentials masked, live
 *   secrets scrubbed).
 */
import { Injectable } from '@nestjs/common';
import { AppLogger, serializeCause } from '../logger';
import { validateEnv, type AppEnv } from '@common/env/env';
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
  isRetryableStatus,
  timeoutError,
} from './external-error';
import { DEFAULT_MAX_DELAY_MS, withRetry, type RetryOptions } from './retry';

export const FALLBACK_REQUEST_TIMEOUT_MS: number = 10000;

/** Retry defaults resolved from env (read-side tuning only). */
type RetryDefaults = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type ExternalFetchOptions = {
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
};

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

function resolveRetryDefaults(): RetryDefaults {
  try {
    const environment: AppEnv = validateEnv(process.env);
    return {
      maxAttempts: environment.externalRetryMaxAttempts,
      baseDelayMs: environment.externalRetryBaseDelayMs,
      maxDelayMs: environment.externalRetryMaxDelayMs,
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
  constructor(private readonly logger: AppLogger = new AppLogger(ExternalClient.name)) {}

  /**
   * GET/… with retry; POST/PUT/PATCH/DELETE exactly once unless
   * `allowNonIdempotentRetry` is true. Resolves with the upstream Response
   * (even non-ok — callers check `.ok`); throws ExternalServiceError only
   * when no usable response exists (network/timeout exhaustion).
   */
  async fetchWithRetry(
    url: string,
    init: RequestInit = {},
    options: ExternalFetchOptions,
  ): Promise<Response> {
    const {
      service,
      operation,
      correlationId,
    }: ExternalFetchOptions = options;
    const timeoutMs: number = resolveTimeoutMs(options.timeoutMs);
    const defaults: RetryDefaults = resolveRetryDefaults();
    const method: string = (init.method ?? 'GET').toUpperCase();
    const retryOptions: RetryOptions = {
      maxAttempts: defaults.maxAttempts,
      baseDelayMs: defaults.baseDelayMs,
      maxDelayMs: defaults.maxDelayMs,
      ...options.retry,
      method: options.retry?.method ?? method,
      allowNonIdempotentRetry:
        options.retry?.allowNonIdempotentRetry ??
        options.allowNonIdempotentRetry ??
        false,
    };

    const startedAt: number = Date.now();
    this.logger.debug(
      `[external] start service=${service} operation=${operation} method=${method}`,
      correlationId,
    );

    try {
      return await withRetry(
        async (attempt: number) => {
          const attemptStartedAt: number = Date.now();
          let response: Response;
          try {
            response = await this.doFetch(url, init, timeoutMs);
          } catch (error) {
            throw this.classifyTransportError(service, operation, attempt, error);
          }
          const latencyMs: number = Date.now() - attemptStartedAt;
          if (isRetryableStatus(response.status)) {
            // Drain before retry so the socket can be reused; the body is
            // intentionally discarded (fixed messages only, never logged).
            await response.arrayBuffer().catch(() => null);
            const retryable: ExternalServiceError = fromStatus(
              service,
              operation,
              response.status,
              attempt,
            );
            this.logger.warn(
              `[external] retry service=${service} operation=${operation} ` +
                `attempt=${attempt} status=${response.status} code=${retryable.code} latencyMs=${latencyMs}`,
              correlationId,
            );
            throw retryable;
          }
          this.logger.debug(
            `[external] success service=${service} operation=${operation} ` +
              `attempt=${attempt} status=${response.status} latencyMs=${latencyMs}`,
            correlationId,
          );
          return response;
        },
        retryOptions,
      );
    } catch (error) {
      const latencyMs: number = Date.now() - startedAt;
      if (error instanceof ExternalServiceError) {
        // One-liner without stack: [module operation status code].
        // Cause/stack (if any) goes to debug only — AppLogger sanitizes it
        // (URL credentials masked, live secrets scrubbed), never to error.
        this.logger.error(
          `[external] failure service=${service} operation=${operation} ` +
            `status=${error.status ?? '-'} code=${error.code} attempt=${error.attempt} latencyMs=${latencyMs}`,
          correlationId,
        );
        if (error.cause !== undefined) {
          this.logger.debug(
            `[external] cause service=${service} operation=${operation} code=${error.code} ` +
              `detail=${serializeCause(error.cause).slice(0, 2000)}`,
            correlationId,
          );
        }
        throw error;
      }
      // Non-retryable 4xx normalization (fromStatus) or unexpected throw —
      // still logged with fixed fields only.
      const normalized: ExternalServiceError = fromUnknown(
        service,
        operation,
        error,
        retryOptions.maxAttempts ?? 1,
      );
      this.logger.error(
        `[external] failure service=${service} operation=${operation} ` +
          `status=${normalized.status ?? '-'} code=${normalized.code} latencyMs=${latencyMs}`,
        correlationId,
      );
      this.logger.debug(
        `[external] cause service=${service} operation=${operation} code=${normalized.code} ` +
          `detail=${serializeCause(normalized.cause ?? error).slice(0, 2000)}`,
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
    const budget: number = resolveTimeoutMs(timeoutMs);
    const controller: AbortController = new AbortController();
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      () => controller.abort(),
      budget,
    );
    try {
      return await fetch(url, { ...init, signal: controller.signal });
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
    error: unknown,
  ): ExternalServiceError {
    if (error instanceof ExternalServiceError) {
      error.attempt = attempt;
      return error;
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      ((error as { name?: unknown }).name === 'AbortError' ||
        (error as { code?: unknown }).code === 'AbortError')
    ) {
      return timeoutError(service, operation, attempt, error);
    }
    return fromUnknown(service, operation, error, attempt);
  }
}
