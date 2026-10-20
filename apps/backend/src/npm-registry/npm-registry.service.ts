import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_NPM_REGISTRY_SCOPE,
  validateEnv,
  type AppEnv,
} from '../env';
import { AppLogger } from '../common/app-logger.service';
import { ExternalClient } from '../common/external/external-client';
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
} from '../common/external/external-error';
import { withRetry } from '../common/external/retry';
import {
  npmRegistryAuthHeaders,
  npmRegistryAuthMode,
  resolveNpmRegistryConfig,
  type NpmRegistryConfig,
} from './npm-registry.config';

export type NpmRegistryStatus = 'up' | 'down' | 'skipped';

/** Internal down reasons (monitoring/logs only — never sent to clients). */
export const NPM_REGISTRY_AUTH_401 = 'AUTH_401';
export const NPM_REGISTRY_AUTH_403 = 'AUTH_403';

/** Short budget for the /health probe — liveness must not wait on upstream. */
export const NPM_REGISTRY_HEALTH_TIMEOUT_MS = 2000;

const FALLBACK_TIMEOUT_MS = 10000;

/**
 * NpmRegistryService — single owner of NPM_REGISTRY_* config + Verdaccio probe.
 *
 * Observe-only: the module NEVER publishes/installs (bun-install wiring via
 * NPM_TOKEN in .npmrc / bunfig [install.scopes] is untouched) — it only
 * checks availability:
 * - GET /-/ping pings Verdaccio (200 `{ ok: true }` with valid credentials).
 * - GET /api/v1/registry/npm/status reports `{ status, url, scope }`
 *   (200 when up, 503 EXTERNAL_UNAVAILABLE + Retry-After 30 otherwise).
 *
 * Auth priority: NPM_REGISTRY_TOKEN (Bearer) wins, else the
 * NPM_REGISTRY_USER/PASSWORD basic pair (Basic), else anonymous. Empty URL →
 * 'skipped' as before.
 *
 * Degradation contract (never-throw):
 * - unconfigured URL → status 'skipped', status endpoint answers 503.
 * - unreachable at boot → onModuleInit retries the ping with backoff+jitter
 *   (GET-only, 429/5xx/network) and settles on 'down' WITHOUT throwing, so
 *   the application still boots; dependents answer 503 EXTERNAL_UNAVAILABLE
 *   with Retry-After 30 (via ApiErrorFilter).
 * - auth failure (ping-level 401 bad-credentials / 403 forbidden) → status
 *   'down' (internal reason AUTH_401/AUTH_403), status endpoint answers 503
 *   EXTERNAL_UNAVAILABLE with the neutral message
 *   'сервис временно недоступен, повторите позже' + Retry-After 30 — the
 *   401/403 detail never leaves the backend (logs/monitoring only).
 * - a later successful call flips back to 'up' with an AppLogger.log.
 *
 * Auth failures are NOT retried (4xx fail fast — withRetry only retries
 * 429/5xx/network on idempotent GET).
 *
 * Secrets (token/user/password, auth headers) never reach logs — only
 * service/operation/attempt/status/authMode (presence fact)/reason reach logs,
 * via ExternalClient + fixed messages here. The URL is never logged either
 * (it may carry credentials via interpolation); scope carries no secrets.
 */
@Injectable()
export class NpmRegistryService implements OnModuleInit {
  private readonly external: ExternalClient;
  private status: NpmRegistryStatus = 'skipped';
  private lastCheckAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    @Optional() private readonly config?: ConfigService,
    private readonly logger: AppLogger = new AppLogger('NpmRegistryService'),
    @Optional() externalClient?: ExternalClient,
  ) {
    this.external = externalClient ?? new ExternalClient(new AppLogger('ExternalClient'));
  }

  private resolvedEnv(): AppEnv | null {
    try {
      return validateEnv(process.env);
    } catch {
      return null;
    }
  }

  private resolved(): NpmRegistryConfig {
    const env = this.resolvedEnv();
    if (env) return resolveNpmRegistryConfig(env);
    // readonly-исключение: fail-open к сырым ConfigService-значениям только для
    // чтения observe-only конфига (trimmed, never logged); пустой URL → 'skipped'
    // + 503 на status (никакого тихого успеха); ретрай-тюнинг дефолтится к
    // EXTERNAL_*-зеркалам при непарсируемом значении.
    const num = (raw: string | undefined, fallback: number): number => {
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 ? n : fallback;
    };
    const scopeRaw = this.config?.get<string>('NPM_REGISTRY_SCOPE')?.trim() ?? '';
    return {
      url: (this.config?.get<string>('NPM_REGISTRY_URL')?.trim() ?? '').replace(/\/+$/, ''),
      token:
        this.config?.get<string>('NPM_REGISTRY_TOKEN')?.trim() ||
        this.config?.get<string>('NPM_TOKEN')?.trim() ||
        '',
      user: this.config?.get<string>('NPM_REGISTRY_USER')?.trim() ?? '',
      password: this.config?.get<string>('NPM_REGISTRY_PASSWORD')?.trim() ?? '',
      scope: /^@[a-z0-9-~][a-z0-9-._~]*$/.test(scopeRaw) ? scopeRaw : DEFAULT_NPM_REGISTRY_SCOPE,
      timeoutMs: num(this.config?.get<string>('NPM_REGISTRY_TIMEOUT_MS'), FALLBACK_TIMEOUT_MS),
      retry: {
        maxAttempts: num(this.config?.get<string>('NPM_REGISTRY_RETRY_MAX_ATTEMPTS'), 3) || 3,
        baseDelayMs: num(this.config?.get<string>('NPM_REGISTRY_RETRY_BASE_DELAY_MS'), 200),
        maxDelayMs: num(this.config?.get<string>('NPM_REGISTRY_RETRY_MAX_DELAY_MS'), 2000),
      },
    };
  }

  /** Canonical registry base URL, no trailing slash ('' = unconfigured). */
  get url(): string {
    return this.resolved().url;
  }

  /** Observed npm scope, e.g. '@web2bizz' (carries no secrets). */
  get scope(): string {
    return this.resolved().scope;
  }

  get currentStatus(): NpmRegistryStatus {
    return this.status;
  }

  get snapshot(): { status: NpmRegistryStatus; lastCheckAt: string | null; lastError: string | null } {
    return { status: this.status, lastCheckAt: this.lastCheckAt, lastError: this.lastError };
  }

  private markUp(): void {
    const was = this.status;
    this.status = 'up';
    this.lastCheckAt = new Date().toISOString();
    this.lastError = null;
    if (was !== 'up') {
      this.logger.log('[npm-registry] reachable (status up)');
    }
  }

  private markDown(reason: string): void {
    this.status = 'down';
    this.lastCheckAt = new Date().toISOString();
    // Fixed message — never the upstream body, URL, or credentials.
    this.lastError = reason;
  }

  /**
   * Boot probe with retry: GET /-/ping only (idempotent), 429/5xx/network with
   * exponential backoff + jitter from NPM_REGISTRY_RETRY_*. Auth failures
   * (401/403) fail fast (no retry) and settle on 'down' with an AUTH_401 /
   * AUTH_403 internal reason. Settles on 'down' when exhausted — NEVER throws,
   * so the app always boots. Logs carry status/reason/authMode facts only —
   * never URL, credentials, or upstream bodies.
   */
  async onModuleInit(): Promise<void> {
    const cfg = this.resolved();
    if (!cfg.url) {
      this.status = 'skipped';
      this.logger.debug('[npm-registry] unconfigured (NPM_REGISTRY_URL empty) — status skipped');
      return;
    }
    try {
      await withRetry(
        async (attempt) => {
          await this.pingOnce(cfg, attempt);
        },
        {
          maxAttempts: cfg.retry.maxAttempts,
          baseDelayMs: cfg.retry.baseDelayMs,
          maxDelayMs: cfg.retry.maxDelayMs,
          method: 'GET',
        },
      );
      this.markUp();
    } catch (err) {
      const upstreamStatus = err instanceof ExternalServiceError ? err.status : undefined;
      const code = err instanceof ExternalServiceError ? err.code : 'EXTERNAL_UNAVAILABLE';
      if (upstreamStatus === 401 || upstreamStatus === 403) {
        const reason = upstreamStatus === 401 ? 'bad-credentials' : 'forbidden';
        this.markDown(upstreamStatus === 401 ? NPM_REGISTRY_AUTH_401 : NPM_REGISTRY_AUTH_403);
        // Fixed fields only — authMode is a presence fact, never values.
        this.logger.error(
          `[npm-registry] auth failed at startup status=${upstreamStatus} reason=${reason} authMode=${npmRegistryAuthMode(cfg)} status=down`,
        );
        return;
      }
      this.markDown(code);
      // Fixed fields only — no URL, no credentials, no upstream body.
      this.logger.error(`[npm-registry] unreachable at startup code=${code} status=down`);
    }
  }

  /**
   * Liveness probe for GET /health. Single attempt on a short budget,
   * always resolves, never throws. Unconfigured → 'skipped'.
   * Auth failure (401/403) → 'down' (logged with reason + authMode facts,
   * never secrets); any other HTTP response except retryable 429/5xx
   * (which throw inside ExternalClient → 'down') means reachable → 'up'.
   */
  async checkConnectivity(timeoutMs = NPM_REGISTRY_HEALTH_TIMEOUT_MS): Promise<NpmRegistryStatus> {
    const cfg = this.resolved();
    if (!cfg.url) return 'skipped';
    try {
      const res = await this.external.fetchWithRetry(
        `${cfg.url}/-/ping`,
        { method: 'GET', headers: npmRegistryAuthHeaders(cfg) },
        {
          service: 'npm-registry',
          operation: 'checkConnectivity',
          timeoutMs,
          retry: { maxAttempts: 1 },
        },
      );
      if (res.status === 401 || res.status === 403) {
        await res.arrayBuffer().catch(() => null);
        const reason = res.status === 401 ? 'bad-credentials' : 'forbidden';
        this.logger.warn(
          `[npm-registry] auth failed status=${res.status} reason=${reason} authMode=${npmRegistryAuthMode(cfg)}`,
        );
        return 'down';
      }
      if (!res.ok && (res.status === 429 || (res.status >= 500 && res.status <= 599))) {
        // Defense-in-depth: ExternalClient already throws retryable 429/5xx, so
        // this branch is normally unreachable — kept so a client behavior change
        // can never flip a 5xx into a false 'up'.
        await res.arrayBuffer().catch(() => null);
        return 'down';
      }
      await res.arrayBuffer().catch(() => null);
      return 'up';
    } catch (err) {
      this.logger.debug(
        `[npm-registry] probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'down';
    }
  }

  /**
   * Live status for GET /api/v1/registry/npm/status. Re-probes Verdaccio on a
   * single attempt (bounded by NPM_REGISTRY_TIMEOUT_MS) so a 200 always means
   * live reachability with valid credentials — never a stale boot flag.
   * Throws ExternalServiceError (503 EXTERNAL_UNAVAILABLE when skipped/down —
   * including auth failures 401/403 — with the neutral message
   * 'сервис временно недоступен, повторите позже' + Retry-After 30 via the
   * filter) — never returns mock data, never leaks 401/403 outward. The
   * 401/403 detail stays in logs/monitoring only (AUTH_401/AUTH_403 +
   * authMode facts, no secrets). A successful call after a 'down'
   * period flips the status back to 'up' (reconnect log).
   */
  async getStatusOrThrow(
    correlationId?: string,
  ): Promise<{ status: 'up'; url: string; scope: string }> {
    const cfg = this.resolved();
    if (!cfg.url) {
      this.logger.warn(
        '[npm-registry] status requested while unconfigured (NPM_REGISTRY_URL empty) — answering 503',
        correlationId,
      );
      throw new ExternalServiceError({
        code: 'EXTERNAL_UNAVAILABLE',
        service: 'npm-registry',
        operation: 'getStatus',
        message: 'сервис временно недоступен, повторите позже',
        attempt: 1,
        isRetryable: false,
      });
    }
    let res: Response;
    try {
      res = await this.external.fetchWithRetry(
        `${cfg.url}/-/ping`,
        { method: 'GET', headers: npmRegistryAuthHeaders(cfg) },
        {
          service: 'npm-registry',
          operation: 'getStatus',
          timeoutMs: cfg.timeoutMs,
          correlationId,
        },
      );
    } catch (err) {
      this.markDown(err instanceof ExternalServiceError ? err.code : 'EXTERNAL_UNAVAILABLE');
      throw err instanceof ExternalServiceError
        ? err
        : fromUnknown('npm-registry', 'getStatus', err, cfg.retry.maxAttempts);
    }
    if (res.status === 401 || res.status === 403) {
      // Closed Verdaccio refused the credential: internal down(auth), outward
      // neutral 503. Drain the body (socket reuse); never echo it.
      await res.arrayBuffer().catch(() => null);
      this.markDown(res.status === 401 ? NPM_REGISTRY_AUTH_401 : NPM_REGISTRY_AUTH_403);
      const reason = res.status === 401 ? 'bad-credentials' : 'forbidden';
      this.logger.error(
        `[npm-registry] auth failed status=${res.status} reason=${reason} authMode=${npmRegistryAuthMode(cfg)} status=down`,
        correlationId,
      );
      throw new ExternalServiceError({
        code: 'EXTERNAL_UNAVAILABLE',
        service: 'npm-registry',
        operation: 'getStatus',
        message: 'сервис временно недоступен, повторите позже',
        status: res.status,
        attempt: cfg.retry.maxAttempts,
        isRetryable: false,
      });
    }
    if (!res.ok && (res.status === 429 || (res.status >= 500 && res.status <= 599))) {
      // Defense-in-depth: ExternalClient already throws retryable 429/5xx, so
      // this branch is normally unreachable — kept so a client behavior change
      // can never flip a 5xx into a false 'up'.
      this.markDown(`UPSTREAM_${res.status}`);
      await res.arrayBuffer().catch(() => null);
      throw fromStatus('npm-registry', 'getStatus', res.status, cfg.retry.maxAttempts);
    }
    // Any other HTTP response (2xx ping, or 404 — the process answered with
    // valid credentials for the ping path) means reachable: drain + mark up.
    await res.arrayBuffer().catch(() => null);
    this.markUp();
    // url/scope carry no secrets (token/user/password are never in the payload).
    return { status: 'up', url: cfg.url, scope: cfg.scope };
  }

  /** Single ping attempt (throws ExternalServiceError on any failure). */
  private async pingOnce(cfg: NpmRegistryConfig, attempt: number): Promise<void> {
    let res: Response;
    try {
      res = await this.external.fetchWithRetry(
        `${cfg.url}/-/ping`,
        { method: 'GET', headers: npmRegistryAuthHeaders(cfg) },
        {
          service: 'npm-registry',
          operation: 'ping',
          timeoutMs: cfg.timeoutMs,
          retry: { maxAttempts: 1 },
        },
      );
    } catch (err) {
      if (err instanceof ExternalServiceError) {
        err.attempt = attempt;
        throw err;
      }
      throw fromUnknown('npm-registry', 'ping', err, attempt);
    }
    // Drain first (socket reuse); the body is never logged.
    await res.arrayBuffer().catch(() => null);
    // Auth refusal fails fast (not retryable — withRetry passes 4xx through):
    // the caller (onModuleInit) maps status 401/403 to AUTH_401/AUTH_403.
    if (res.status === 401 || res.status === 403) {
      throw fromStatus('npm-registry', 'ping', res.status, attempt);
    }
    // Only 429/5xx are retryable failures worth another attempt; any other
    // HTTP response (2xx, or 404 = unexpected path but the process answered)
    // counts as reachable.
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      throw fromStatus('npm-registry', 'ping', res.status, attempt);
    }
  }
}
