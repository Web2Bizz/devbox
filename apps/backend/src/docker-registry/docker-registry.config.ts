import type { AppEnv } from '../env';

/**
 * Typed docker-registry config (resolved from AppEnv, never read from
 * process.env directly). Mirrors the EXTERNAL_RETRY_* tuning shape so the
 * startup probe reuses the shared withRetry backoff+jitter policy.
 */
export type DockerRegistryRetryConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type DockerRegistryConfig = {
  /** Base URL, no trailing slash; '' = unconfigured (health 'skipped'). */
  url: string;
  /** Basic-auth username ('' when unset/token mode; never logged). */
  user: string;
  /** Basic-auth password ('' when unset/token mode; never logged). */
  password: string;
  /** Bearer token — wins over the basic pair when set (never logged). */
  token: string;
  /** Per-attempt budget ms for GET /v2/* calls. */
  timeoutMs: number;
  retry: DockerRegistryRetryConfig;
};

export function resolveDockerRegistryConfig(env: AppEnv): DockerRegistryConfig {
  return {
    url: env.dockerRegistryUrl,
    user: env.dockerRegistryUser,
    password: env.dockerRegistryPassword,
    token: env.dockerRegistryToken,
    timeoutMs: env.dockerRegistryTimeoutMs,
    retry: {
      maxAttempts: env.dockerRegistryRetryMaxAttempts,
      baseDelayMs: env.dockerRegistryRetryBaseDelayMs,
      maxDelayMs: env.dockerRegistryRetryMaxDelayMs,
    },
  };
}

export function isRegistryConfigured(config: DockerRegistryConfig): boolean {
  return Boolean(config.url);
}

/** True when the basic pair is complete (token mode ignores the pair). */
export function hasBasicPair(config: DockerRegistryConfig): boolean {
  return Boolean(config.user && config.password);
}

/**
 * Auth headers for registry GETs. Token mode → `Authorization: Bearer …`;
 * complete basic pair → `Authorization: Basic base64(user:pass)`;
 * otherwise → no auth header (anonymous).
 *
 * The returned header VALUE carries a secret — callers must never log it
 * (AppLogger redacts `authorization` keys; still, never pass headers to logs).
 */
export function dockerRegistryAuthHeaders(
  config: DockerRegistryConfig,
): Record<string, string> {
  if (config.token) return { authorization: `Bearer ${config.token}` };
  if (config.user && config.password) {
    return {
      authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`,
    };
  }
  return {};
}
