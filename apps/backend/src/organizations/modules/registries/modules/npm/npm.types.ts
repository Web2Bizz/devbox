/**
 * Local npm-registry types (plain shapes, no runtime).
 * Resolved from AppEnv via `resolveNpmRegistryConfig` in npm.config.ts.
 */
export type NpmRegistryRetryConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type NpmRegistryConfig = {
  /** Base URL, no trailing slash; '' = unconfigured (health 'skipped'). */
  url: string;
  /** Bearer token — wins over the basic pair when set (never logged). */
  token: string;
  /** Basic-auth username for the closed Verdaccio ('' when unset/token mode; never logged). */
  user: string;
  /** Basic-auth password for the closed Verdaccio ('' when unset/token mode; never logged). */
  password: string;
  /** Observed npm scope, e.g. '@web2bizz' (carries no secrets). */
  scope: string;
  /** Per-attempt budget ms for GET /-/ping calls. */
  timeoutMs: number;
  retry: NpmRegistryRetryConfig;
};
