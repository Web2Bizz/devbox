import type { AppEnv } from '../../../../../common/env/env';
import type {
  NpmRegistryConfig,
  NpmRegistryRetryConfig,
} from './npm.types';

export type { NpmRegistryConfig, NpmRegistryRetryConfig } from './npm.types';

/**
 * Typed npm-registry config (resolved from AppEnv, never read from
 * process.env directly). Mirrors the EXTERNAL_RETRY_* tuning shape so the
 * startup probe reuses the shared withRetry backoff+jitter policy.
 */

export function resolveNpmRegistryConfig(env: AppEnv): NpmRegistryConfig {
  return {
    url: env.npmRegistryUrl,
    token: env.npmRegistryToken,
    user: env.npmRegistryUser,
    password: env.npmRegistryPassword,
    scope: env.npmRegistryScope,
    timeoutMs: env.npmRegistryTimeoutMs,
    retry: {
      maxAttempts: env.npmRegistryRetryMaxAttempts,
      baseDelayMs: env.npmRegistryRetryBaseDelayMs,
      maxDelayMs: env.npmRegistryRetryMaxDelayMs,
    },
  };
}

export function isNpmRegistryConfigured(config: NpmRegistryConfig): boolean {
  return Boolean(config.url);
}

/**
 * Auth headers for the Verdaccio GET probe. Priority: TOKEN (Bearer) wins,
 * else the complete USER/PASSWORD basic pair (Basic base64(user:pass)),
 * otherwise → no auth header (anonymous).
 *
 * The returned header VALUE carries a secret — callers must never log it
 * (AppLogger redacts `authorization` keys; still, never pass headers to logs).
 */
export function npmRegistryAuthHeaders(
  config: NpmRegistryConfig,
): Record<string, string> {
  if (config.token) return { authorization: `Bearer ${config.token}` };
  if (config.user && config.password) {
    return {
      authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`,
    };
  }
  return {};
}

/** True when the basic pair is complete (token mode ignores the pair). */
export function hasNpmBasicPair(config: NpmRegistryConfig): boolean {
  return Boolean(config.user && config.password);
}

/**
 * Auth mode fact for logs/monitoring (presence only — never values).
 * 'token' | 'basic' | 'anonymous'.
 */
export function npmRegistryAuthMode(
  config: Pick<NpmRegistryConfig, 'token' | 'user' | 'password'>,
): 'token' | 'basic' | 'anonymous' {
  if (config.token) return 'token';
  if (config.user && config.password) return 'basic';
  return 'anonymous';
}
