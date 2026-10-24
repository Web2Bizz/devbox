import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateEnv, type AppEnv } from '../env';
import { AppLogger } from '../common/app-logger.service';
import { ExternalClient } from '../common/external/external-client';
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
} from '../common/external/external-error';
import { withRetry } from '../common/external/retry';
import {
  dockerRegistryAuthHeaders,
  resolveDockerRegistryConfig,
  type DockerRegistryConfig,
} from './docker-registry.config';

export type DockerRegistryStatus = 'up' | 'down' | 'skipped';

/** Short budget for the /health probe — liveness must not wait on upstream. */
export const DOCKER_REGISTRY_HEALTH_TIMEOUT_MS = 2000;

const FALLBACK_TIMEOUT_MS = 10000;

/**
 * DockerRegistryService — single owner of DOCKER_REGISTRY_* config + v2 fetch.
 *
 * Docker Registry HTTP API v2 (basic client — ping + catalog only):
 * - GET /v2/ pings the registry (200 anonymous, 401/403 when auth is
 *   required — any HTTP response means the process is up).
 * - GET /v2/_catalog lists repositories (`{ repositories: string[] }`).
 *
 * Degradation contract (never-throw):
 * - unconfigured URL → status 'skipped', catalog answers 503.
 * - unreachable at boot → onModuleInit retries the ping with backoff+jitter
 *   (GET-only, 429/5xx/network) and settles on 'down' WITHOUT throwing, so
 *   the application still boots; dependents answer 503 EXTERNAL_UNAVAILABLE
 *   with Retry-After 30 (via ApiErrorFilter).
 * - a later successful call flips back to 'up' with an AppLogger.log.
 *
 * Secrets (user/password/token, auth headers) never reach logs — only
 * service/operation/attempt/status are logged, via ExternalClient + fixed
 * messages here.
 */
@Injectable()
export class DockerRegistryService implements OnModuleInit {
  private readonly external: ExternalClient;
  private status: DockerRegistryStatus = 'skipped';
  private lastCheckAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    @Optional() private readonly config?: ConfigService,
    private readonly logger: AppLogger = new AppLogger('DockerRegistryService'),
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

  private resolved(): DockerRegistryConfig {
    const env = this.resolvedEnv();
    if (env) return resolveDockerRegistryConfig(env);
    // readonly-исключение: fail-open к сырым ConfigService-значениям только для
    // чтения observe-only конфига (trimmed, never logged); пустой URL → 'skipped'
    // + 503 на catalog (никакого тихого успеха); ретрай-тюнинг дефолтится к
    // EXTERNAL_*-зеркалам при непарсируемом значении.
    const num = (raw: string | undefined, fallback: number): number => {
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 ? n : fallback;
    };
    return {
      url: (this.config?.get<string>('DOCKER_REGISTRY_URL')?.trim() ?? '').replace(/\/+$/, ''),
      user: this.config?.get<string>('DOCKER_REGISTRY_USER')?.trim() ?? '',
      password: this.config?.get<string>('DOCKER_REGISTRY_PASSWORD')?.trim() ?? '',
      token: this.config?.get<string>('DOCKER_REGISTRY_TOKEN')?.trim() ?? '',
      timeoutMs: num(this.config?.get<string>('DOCKER_REGISTRY_TIMEOUT_MS'), FALLBACK_TIMEOUT_MS),
      retry: {
        maxAttempts: num(this.config?.get<string>('DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS'), 3) || 3,
        baseDelayMs: num(this.config?.get<string>('DOCKER_REGISTRY_RETRY_BASE_DELAY_MS'), 200),
        maxDelayMs: num(this.config?.get<string>('DOCKER_REGISTRY_RETRY_MAX_DELAY_MS'), 2000),
      },
    };
  }

  /** Canonical registry base URL, no trailing slash ('' = unconfigured). */
  get url(): string {
    return this.resolved().url;
  }

  get currentStatus(): DockerRegistryStatus {
    return this.status;
  }

  get snapshot(): { status: DockerRegistryStatus; lastCheckAt: string | null; lastError: string | null } {
    return { status: this.status, lastCheckAt: this.lastCheckAt, lastError: this.lastError };
  }

  private markUp(): void {
    const was = this.status;
    this.status = 'up';
    this.lastCheckAt = new Date().toISOString();
    this.lastError = null;
    if (was !== 'up') {
      this.logger.log('[docker-registry] reachable (status up)');
    }
  }

  private markDown(reason: string): void {
    this.status = 'down';
    this.lastCheckAt = new Date().toISOString();
    // Fixed message — never the upstream body, URL, or credentials.
    this.lastError = reason;
  }

  /**
   * Boot probe with retry: GET /v2/ only (idempotent), 429/5xx/network with
   * exponential backoff + jitter from DOCKER_REGISTRY_RETRY_*. Settles on
   * 'down' when exhausted — NEVER throws, so the app always boots.
   */
  async onModuleInit(): Promise<void> {
    const cfg = this.resolved();
    if (!cfg.url) {
      this.status = 'skipped';
      this.logger.debug('[docker-registry] unconfigured (DOCKER_REGISTRY_URL empty) — status skipped');
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
      const code = err instanceof ExternalServiceError ? err.code : 'EXTERNAL_UNAVAILABLE';
      this.markDown(code);
      // Fixed fields only — no URL, no credentials, no upstream body.
      this.logger.error(`[docker-registry] unreachable at startup code=${code} status=down`);
    }
  }

  /**
   * Liveness probe for GET /health. Single attempt on a short budget,
   * always resolves, never throws. Unconfigured → 'skipped'.
   */
  async checkConnectivity(timeoutMs = DOCKER_REGISTRY_HEALTH_TIMEOUT_MS): Promise<DockerRegistryStatus> {
    const cfg = this.resolved();
    if (!cfg.url) return 'skipped';
    try {
      await this.external.fetchWithRetry(
        `${cfg.url}/v2/`,
        { method: 'GET', headers: dockerRegistryAuthHeaders(cfg) },
        {
          service: 'docker-registry',
          operation: 'checkConnectivity',
          timeoutMs,
          retry: { maxAttempts: 1 },
        },
      );
      // Any HTTP response (even 401/403/5xx — returned, not thrown) means up.
      return 'up';
    } catch (err) {
      this.logger.debug(
        `[docker-registry] probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'down';
    }
  }

  /**
   * GET /v2/_catalog → repository names. Throws ExternalServiceError
   * (503 EXTERNAL_UNAVAILABLE when skipped/down → Retry-After 30 via the
   * filter) — never returns mock data. A successful call after a 'down'
   * period flips the status back to 'up' (reconnect log).
   */
  async listCatalog(correlationId?: string): Promise<string[]> {
    const cfg = this.resolved();
    if (!cfg.url) {
      this.logger.warn(
        '[docker-registry] catalog requested while unconfigured (DOCKER_REGISTRY_URL empty) — answering 503',
        correlationId,
      );
      throw new ExternalServiceError({
        code: 'EXTERNAL_UNAVAILABLE',
        service: 'docker-registry',
        operation: 'listCatalog',
        message: 'сервис временно недоступен, повторите позже',
        attempt: 1,
        isRetryable: false,
      });
    }
    let res: Response;
    try {
      res = await this.external.fetchWithRetry(
        `${cfg.url}/v2/_catalog`,
        { method: 'GET', headers: dockerRegistryAuthHeaders(cfg) },
        {
          service: 'docker-registry',
          operation: 'listCatalog',
          timeoutMs: cfg.timeoutMs,
          correlationId,
        },
      );
    } catch (err) {
      this.markDown(err instanceof ExternalServiceError ? err.code : 'EXTERNAL_UNAVAILABLE');
      throw err instanceof ExternalServiceError
        ? err
        : fromUnknown('docker-registry', 'listCatalog', err, cfg.retry.maxAttempts);
    }
    if (!res.ok) {
      this.markDown(`UPSTREAM_${res.status}`);
      await res.arrayBuffer().catch(() => null);
      throw fromStatus('docker-registry', 'listCatalog', res.status, cfg.retry.maxAttempts);
    }
    let payload: unknown;
    try {
      payload = (await res.json()) as unknown;
    } catch (err) {
      this.markDown('EXTERNAL_UPSTREAM_5XX');
      throw fromUnknown('docker-registry', 'listCatalog', err, cfg.retry.maxAttempts);
    }
    const repos = (payload as { repositories?: unknown }).repositories;
    if (!Array.isArray(repos) || !repos.every((r): r is string => typeof r === 'string')) {
      this.markDown('EXTERNAL_UPSTREAM_5XX');
      throw new ExternalServiceError({
        code: 'EXTERNAL_UPSTREAM_5XX',
        service: 'docker-registry',
        operation: 'listCatalog',
        message: 'Upstream service returned a server error',
        attempt: cfg.retry.maxAttempts,
        isRetryable: true,
      });
    }
    this.markUp();
    return repos;
  }

  /** Single ping attempt (throws ExternalServiceError on any failure). */
  private async pingOnce(cfg: DockerRegistryConfig, attempt: number): Promise<void> {
    let res: Response;
    try {
      res = await this.external.fetchWithRetry(
        `${cfg.url}/v2/`,
        { method: 'GET', headers: dockerRegistryAuthHeaders(cfg) },
        {
          service: 'docker-registry',
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
      throw fromUnknown('docker-registry', 'ping', err, attempt);
    }
    // Any HTTP response counts as reachable (401/403 = auth required, still up).
    await res.arrayBuffer().catch(() => null);
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      throw fromStatus('docker-registry', 'ping', res.status, attempt);
    }
  }
}
