import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateEnv, type AppEnv } from '@common/env/env';
import { AppLogger } from '@common/logger';
import { ExternalClient } from '@common/external/external-client';
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
} from '@common/external/external-error';
import { withRetry } from '@common/external/retry';
import {
  dockerRegistryAuthHeaders,
  resolveDockerRegistryConfig,
  type DockerRegistryConfig,
} from './docker.config';

export type DockerRegistryStatus = 'up' | 'down' | 'skipped';

/** Short budget for the /health probe — liveness must not wait on upstream. */
export const DOCKER_REGISTRY_HEALTH_TIMEOUT_MS: number = 2000;

const FALLBACK_TIMEOUT_MS: number = 10000;

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
    private readonly logger: AppLogger = new AppLogger(DockerRegistryService.name),
    @Optional() private readonly externalClient?: ExternalClient,
  ) {
    this.external = this.externalClient ?? new ExternalClient(new AppLogger(DockerRegistryService.name));
  }

  private resolvedEnv(): AppEnv | null {
    try {
      return validateEnv(process.env);
    } catch {
      return null;
    }
  }

  private resolved(): DockerRegistryConfig {
    const env: AppEnv | null = this.resolvedEnv();
    if (env) return resolveDockerRegistryConfig(env);
    // readonly-исключение: fail-open к сырым ConfigService-значениям только для
    // чтения observe-only конфига (trimmed, never logged); пустой URL → 'skipped'
    // + 503 на catalog (никакого тихого успеха); ретрай-тюнинг дефолтится к
    // EXTERNAL_*-зеркалам при непарсируемом значении.
    const parseNonNegativeInt: (rawValue: string | undefined, fallback: number) => number = (
      rawValue: string | undefined,
      fallback: number,
    ): number => {
      const parsed: number = Number(rawValue);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
    };
    return {
      url: (this.config?.get<string>('DOCKER_REGISTRY_URL')?.trim() ?? '').replace(/\/+$/, ''),
      user: this.config?.get<string>('DOCKER_REGISTRY_USER')?.trim() ?? '',
      password: this.config?.get<string>('DOCKER_REGISTRY_PASSWORD')?.trim() ?? '',
      token: this.config?.get<string>('DOCKER_REGISTRY_TOKEN')?.trim() ?? '',
      timeoutMs: parseNonNegativeInt(this.config?.get<string>('DOCKER_REGISTRY_TIMEOUT_MS'), FALLBACK_TIMEOUT_MS),
      retry: {
        maxAttempts: parseNonNegativeInt(this.config?.get<string>('DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS'), 3) || 3,
        baseDelayMs: parseNonNegativeInt(this.config?.get<string>('DOCKER_REGISTRY_RETRY_BASE_DELAY_MS'), 200),
        maxDelayMs: parseNonNegativeInt(this.config?.get<string>('DOCKER_REGISTRY_RETRY_MAX_DELAY_MS'), 2000),
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
    const previousStatus: DockerRegistryStatus = this.status;
    this.status = 'up';
    this.lastCheckAt = new Date().toISOString();
    this.lastError = null;
    if (previousStatus !== 'up') {
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
    const configuration: DockerRegistryConfig = this.resolved();
    if (!configuration.url) {
      this.status = 'skipped';
      this.logger.debug('[docker-registry] unconfigured (DOCKER_REGISTRY_URL empty) — status skipped');
      return;
    }
    try {
      await withRetry(
        async (attempt: number) => {
          await this.pingOnce(configuration, attempt);
        },
        {
          maxAttempts: configuration.retry.maxAttempts,
          baseDelayMs: configuration.retry.baseDelayMs,
          maxDelayMs: configuration.retry.maxDelayMs,
          method: 'GET',
        },
      );
      this.markUp();
    } catch (error) {
      const code: string =
        error instanceof ExternalServiceError ? error.code : 'EXTERNAL_UNAVAILABLE';
      this.markDown(code);
      // Fixed fields only — no URL, no credentials, no upstream body.
      this.logger.error(`[docker-registry] unreachable at startup code=${code} status=down`);
    }
  }

  /**
   * Liveness probe for GET /health. Single attempt on a short budget,
   * always resolves, never throws. Unconfigured → 'skipped'.
   */
  async checkConnectivity(
    timeoutMs: number = DOCKER_REGISTRY_HEALTH_TIMEOUT_MS,
  ): Promise<DockerRegistryStatus> {
    const configuration: DockerRegistryConfig = this.resolved();
    if (!configuration.url) return 'skipped';
    try {
      await this.external.fetchWithRetry(
        `${configuration.url}/v2/`,
        { method: 'GET', headers: dockerRegistryAuthHeaders(configuration) },
        {
          service: 'docker-registry',
          operation: 'checkConnectivity',
          timeoutMs,
          retry: { maxAttempts: 1 },
        },
      );
      // Any HTTP response (even 401/403/5xx — returned, not thrown) means up.
      return 'up';
    } catch (error) {
      this.logger.debug(
        `[docker-registry] probe failed: ${error instanceof Error ? error.message : String(error)}`,
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
  async listCatalog(correlationId?: string): Promise<Array<string>> {
    const configuration: DockerRegistryConfig = this.resolved();
    if (!configuration.url) {
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
    let response: Response;
    try {
      response = await this.external.fetchWithRetry(
        `${configuration.url}/v2/_catalog`,
        { method: 'GET', headers: dockerRegistryAuthHeaders(configuration) },
        {
          service: 'docker-registry',
          operation: 'listCatalog',
          timeoutMs: configuration.timeoutMs,
          correlationId,
        },
      );
    } catch (error) {
      this.markDown(error instanceof ExternalServiceError ? error.code : 'EXTERNAL_UNAVAILABLE');
      throw error instanceof ExternalServiceError
        ? error
        : fromUnknown('docker-registry', 'listCatalog', error, configuration.retry.maxAttempts);
    }
    if (!response.ok) {
      this.markDown(`UPSTREAM_${response.status}`);
      await response.arrayBuffer().catch(() => null);
      throw fromStatus('docker-registry', 'listCatalog', response.status, configuration.retry.maxAttempts);
    }
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (error) {
      this.markDown('EXTERNAL_UPSTREAM_5XX');
      throw fromUnknown('docker-registry', 'listCatalog', error, configuration.retry.maxAttempts);
    }
    const repositories: unknown = (payload as { repositories?: unknown }).repositories;
    if (
      !Array.isArray(repositories) ||
      !repositories.every((repository): repository is string => typeof repository === 'string')
    ) {
      this.markDown('EXTERNAL_UPSTREAM_5XX');
      throw new ExternalServiceError({
        code: 'EXTERNAL_UPSTREAM_5XX',
        service: 'docker-registry',
        operation: 'listCatalog',
        message: 'Upstream service returned a server error',
        attempt: configuration.retry.maxAttempts,
        isRetryable: true,
      });
    }
    this.markUp();
    return repositories;
  }

  /** Single ping attempt (throws ExternalServiceError on any failure). */
  private async pingOnce(configuration: DockerRegistryConfig, attempt: number): Promise<void> {
    let response: Response;
    try {
      response = await this.external.fetchWithRetry(
        `${configuration.url}/v2/`,
        { method: 'GET', headers: dockerRegistryAuthHeaders(configuration) },
        {
          service: 'docker-registry',
          operation: 'ping',
          timeoutMs: configuration.timeoutMs,
          retry: { maxAttempts: 1 },
        },
      );
    } catch (error) {
      if (error instanceof ExternalServiceError) {
        error.attempt = attempt;
        throw error;
      }
      throw fromUnknown('docker-registry', 'ping', error, attempt);
    }
    // Any HTTP response counts as reachable (401/403 = auth required, still up).
    await response.arrayBuffer().catch(() => null);
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      throw fromStatus('docker-registry', 'ping', response.status, attempt);
    }
  }
}
