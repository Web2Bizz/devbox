import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateEnv } from '../env';
import { AppLogger } from '../common/app-logger.service';
import { ExternalClient } from '../common/external/external-client';

export type OpencodeStatus = 'up' | 'down';

/** Short probe budget for GET /health — liveness must not wait on upstream. */
export const OPENCODE_HEALTH_TIMEOUT_MS = 2000;

const FALLBACK_URL = 'http://localhost:4096';
const FALLBACK_TIMEOUT_MS = 10000;

/**
 * OpencodeService — single owner of OPENCODE_* config + upstream fetch.
 *
 * - Canonical `url` preserves an explicit 0.0.0.0 host verbatim
 *   (the stand listens on all interfaces; env assembly never rewrites it).
 * - `dialUrl()` remaps undialable 0.0.0.0 / :: → 127.0.0.1 for outbound
 *   requests only; localhost configs pass through untouched.
 * - `fetchWithTimeout()` is the shared single-attempt upstream fetch
 *   (AbortController + REQUEST_TIMEOUT_MS budget) used by health probing —
 *   routed through ExternalClient so attempts are logged uniformly.
 * - `fetchWithRetry()` adds bounded retry for idempotent (GET) upstream
 *   calls (429/5xx/timeout, EXTERNAL_RETRY_* tuning); POST/… still run once
 *   unless `allowNonIdempotentRetry` is passed explicitly.
 * - `checkConnectivity()` never throws and never logs secrets (the URL
 *   carries no credentials; only the error message is logged at debug).
 *   Liveness stays single-attempt — no retry budget on the probe.
 */
@Injectable()
export class OpencodeService {
  private readonly external: ExternalClient;

  constructor(
    @Optional() private readonly config?: ConfigService,
    private readonly logger: AppLogger = new AppLogger('OpencodeService'),
    @Optional() externalClient?: ExternalClient,
  ) {
    this.external = externalClient ?? new ExternalClient(new AppLogger('ExternalClient'));
  }

  private resolved(): { url: string; timeoutMs: number } {
    try {
      const env = validateEnv(process.env);
      return { url: env.opencodeUrl, timeoutMs: env.requestTimeoutMs };
    } catch {
      // readonly-исключение: fail-open к сырым ConfigService-значениям только
      // для чтения конфига (trimmed, never logged); явный OPENCODE_URL имеет
      // приоритет, dev-дефолт FALLBACK_URL — лишь когда ничего не задано.
      // Валидационные ERROR validateEnv (bad PORT/URL/...) при этом не маскируются
      // под успех — boot всё равно падает в ConfigModule.validate, а запросы к
      // незаданному апстриму отвечают 503 (never 200 mock).
      const url = this.config?.get<string>('OPENCODE_URL')?.trim() || FALLBACK_URL;
      const timeoutRaw = Number(this.config?.get<string>('REQUEST_TIMEOUT_MS'));
      const timeoutMs =
        Number.isInteger(timeoutRaw) && timeoutRaw >= 0 ? timeoutRaw : FALLBACK_TIMEOUT_MS;
      return { url: url.replace(/\/+$/, ''), timeoutMs };
    }
  }

  /** Canonical opencode URL, no trailing slash, explicit 0.0.0.0 preserved. */
  get url(): string {
    return this.resolved().url;
  }

  get host(): string {
    try {
      return new URL(this.url).hostname;
    } catch {
      // readonly-исключение: оборонительный парс-дефолт (url уже валидирован в
      // resolved()/validateEnv — ветка практически недостижима); чтение, не запись.
      return 'localhost';
    }
  }

  get port(): number {
    try {
      const p = Number(new URL(this.url).port);
      return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : 4096;
    } catch {
      // readonly-исключение: см. host выше — оборонительный дефолт парсинга.
      return 4096;
    }
  }

  get protocol(): 'http' | 'https' {
    try {
      return new URL(this.url).protocol === 'https:' ? 'https' : 'http';
    } catch {
      // readonly-исключение: см. host выше — оборонительный дефолт парсинга.
      return 'http';
    }
  }

  get timeoutMs(): number {
    return this.resolved().timeoutMs;
  }

  /**
   * Dialable base URL: 0.0.0.0 / :: mean "all interfaces" and are not
   * dialable on every platform — probe 127.0.0.1 instead. The configured
   * `url` getter keeps 0.0.0.0 verbatim; only outbound dialing is remapped.
   */
  dialUrl(): string {
    try {
      const parsed = new URL(this.url);
      if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::') {
        parsed.hostname = '127.0.0.1';
      }
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return this.url;
    }
  }

  async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<Response> {
    const budget = timeoutMs ?? this.timeoutMs;
    try {
      return await this.external.fetchWithRetry(
        url,
        init,
        {
          service: 'opencode',
          operation: 'fetch',
          timeoutMs: budget,
          // Single attempt — same semantics as the old AbortController fetch;
          // retry lives in fetchWithRetry() for idempotent callers.
          retry: { maxAttempts: 1 },
        },
      );
    } catch (err) {
      // ExternalClient throws only when no response exists (network/timeout);
      // translate back to the historical throw shape (AbortError-aware
      // callers check `.name`) without leaking internals.
      const asError = err instanceof Error ? err : new Error(String(err));
      throw asError;
    }
  }

  /**
   * Bounded-retry upstream fetch for idempotent calls. Non-idempotent
   * methods run exactly once unless `allowNonIdempotentRetry` is true.
   * Resolves with the upstream Response (even non-ok); throws
   * ExternalServiceError only when no response exists.
   */
  fetchWithRetry(
    url: string,
    init: RequestInit = {},
    opts: { operation?: string; timeoutMs?: number; allowNonIdempotentRetry?: boolean } = {},
  ): Promise<Response> {
    return this.external.fetchWithRetry(url, init, {
      service: 'opencode',
      operation: opts.operation ?? 'fetch',
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      allowNonIdempotentRetry: opts.allowNonIdempotentRetry,
    });
  }

  /**
   * Liveness probe for the opencode server. Any HTTP response (even 404 —
   * the server may not serve `/`) means the process is up; network errors
   * and timeouts mean down. Always resolves, never throws.
   */
  async checkConnectivity(timeoutMs = OPENCODE_HEALTH_TIMEOUT_MS): Promise<OpencodeStatus> {
    try {
      const res = await this.fetchWithTimeout(`${this.dialUrl()}/`, { method: 'GET' }, timeoutMs);
      // Drain the body to free the socket; parse errors are irrelevant here.
      await res.arrayBuffer().catch(() => null);
      return 'up';
    } catch (err) {
      this.logger.debug(`[opencode] unreachable: ${(err as Error).message}`);
      return 'down';
    }
  }
}
