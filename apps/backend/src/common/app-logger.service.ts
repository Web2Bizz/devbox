import { Injectable, Logger, Optional, type LogLevel } from '@nestjs/common';
import { validateEnv } from '../env.js';

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<AppLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Object keys whose values must never reach the logs. */
const SECRET_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'apikey',
  'api_key',
  'databaseurl',
  'database_url',
  'connectionstring',
  'connection_string',
  'postgres_password',
  'postgrespassword',
  // Docker registry auth (camelCase config keys + env names, lowercased).
  'dockerregistryuser',
  'dockerregistrypassword',
  'dockerregistrytoken',
  'docker_registry_user',
  'docker_registry_password',
  'docker_registry_token',
  // npm registry (Verdaccio) auth — NPM_REGISTRY_TOKEN (+ legacy NPM_TOKEN
  // fallback) and the NPM_REGISTRY_USER/PASSWORD basic pair must never reach
  // logs; scope/url carry no secrets.
  'npmregistrytoken',
  'npm_registry_token',
  'npm_token',
  'npmtoken',
  'npmregistryuser',
  'npm_registry_user',
  'npmregistrypassword',
  'npm_registry_password',
  // Auth (internal accounts): JWT secrets, password hashes, refresh/access
  // tokens must never reach logs (values scrubbed, keys redacted).
  'jwtaccesssecret',
  'jwt_access_secret',
  'jwtrefreshsecret',
  'jwt_refresh_secret',
  'jwt_access_ttl',
  'jwt_refresh_ttl',
  'jwtttl',
  'passwordhash',
  'password_hash',
]);

/** Matches `scheme://user:pass@host` credentials inside URL strings. */
const CREDENTIALS_IN_URL = /:\/\/([^/\s:@]+)(:[^/\s@]*)?@/g;

function currentLevel(): AppLogLevel {
  try {
    return validateEnv(process.env).logLevel;
  } catch {
    return 'info';
  }
}

function isEnabled(level: AppLogLevel): boolean {
  return RANK[level] >= RANK[currentLevel()];
}

/** Collects live secret values (never logged, only used for redaction). */
function liveSecrets(): string[] {
  const out: string[] = [];
  for (const v of [
    process.env.DATABASE_URL,
    process.env.POSTGRES_PASSWORD,
    process.env.DOCKER_REGISTRY_USER,
    process.env.DOCKER_REGISTRY_PASSWORD,
    process.env.DOCKER_REGISTRY_TOKEN,
    process.env.NPM_REGISTRY_TOKEN,
    process.env.NPM_TOKEN,
    process.env.NPM_REGISTRY_USER,
    process.env.NPM_REGISTRY_PASSWORD,
    process.env.JWT_ACCESS_SECRET,
    process.env.JWT_REFRESH_SECRET,
  ]) {
    if (v && v.length >= 4) out.push(v);
  }
  return out;
}

function maskUrlCredentials(text: string): string {
  return text.replace(CREDENTIALS_IN_URL, '://***:***@');
}

function sanitizeString(text: string): string {
  let out = maskUrlCredentials(text);
  for (const secret of liveSecrets()) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (depth > 4) return '[truncated]';
  if (value instanceof Error) {
    // Message only — stacks may embed URLs/query strings with credentials.
    return sanitizeString(value.message);
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase())
      ? '[redacted]'
      : sanitizeValue(v, depth + 1, seen);
  }
  return out;
}

function formatMessage(message: unknown, correlationId?: string): string {
  const clean = sanitizeValue(message);
  const text = typeof clean === 'string' ? clean : JSON.stringify(clean);
  return correlationId ? `[${correlationId}] ${text}` : text;
}

/**
 * Maps our LOG_LEVEL to Nest framework log levels for `NestFactory.create()`.
 * debug → everything; info → log/warn/error/fatal; warn → warn+; error → error+.
 */
export function nestLogLevels(level: AppLogLevel = currentLevel()): LogLevel[] {
  switch (level) {
    case 'debug':
      return ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
    case 'warn':
      return ['warn', 'error', 'fatal'];
    case 'error':
      return ['error', 'fatal'];
    case 'info':
    default:
      return ['log', 'warn', 'error', 'fatal'];
  }
}

/**
 * AppLogger — the only sanctioned logging path in the backend.
 *
 * Follows the NestJS Logger guide:
 * - levels: `verbose`/`debug` (diagnostics) → `log` (`info` alias, lifecycle)
 *   → `warn` (degraded, still serving) → `error` (failed operation) →
 *   `fatal` (process cannot continue). Respects LOG_LEVEL from validateEnv()
 *   (fail-open to 'info'); `nestLogLevels()` maps it to framework levels.
 * - context: set per service via `new AppLogger('ServiceName')` (DI or
 *   default-param); the `[domain] event key=value` message prefix stays
 *   greppable and carries structured fields, never secrets.
 * - errors: `error(message, stack?, correlationId?)` — Nest-compatible
 *   `(message, stack, context)` shape; stacks are sanitized (URL credentials
 *   masked, live secrets scrubbed) before reaching the underlying Logger.
 * - requests: pass `correlationId` (or `withCorrelationId(cid)` for a bound
 *   logger) so every line of one request shares `[cid]`.
 * - secrets: known secret keys redacted, URL credentials masked,
 *   live DATABASE_URL / POSTGRES_PASSWORD values scrubbed, Error → message
 *   only by default. Never log tokens, passwords, connection strings, or PII
 *   (e.g. emails) — use fixed event names instead.
 */
@Injectable()
export class AppLogger extends Logger {
  // @Optional: `context` is a plain string, not a DI token — Nest must not
  // try to resolve it. Direct `new AppLogger('Ctx')` still sets the context.
  constructor(@Optional() context?: string) {
    super(context ?? 'App');
  }

  debug(message: unknown, correlationId?: string): void {
    if (!isEnabled('debug')) return;
    super.debug(formatMessage(message, correlationId));
  }

  /** `info` maps to Nest `log` (Nest has no `info` level). */
  info(message: unknown, correlationId?: string): void {
    if (!isEnabled('info')) return;
    super.log(formatMessage(message, correlationId));
  }

  override log(message: unknown, correlationId?: string): void {
    this.info(message, correlationId);
  }

  override warn(message: unknown, correlationId?: string): void {
    if (!isEnabled('warn')) return;
    super.warn(formatMessage(message, correlationId));
  }

  override error(message: unknown, stackOrCorrelationId?: string, correlationId?: string): void {
    if (!isEnabled('error')) return;
    // Nest-compatible: error(message, stack?, context?). Our second arg
    // historically carried the correlationId, so disambiguate by shape:
    // a multiline value is a stack (stacks always contain '\n'); a single
    // line is a correlationId. Three-arg calls are always (msg, stack, cid).
    const secondLooksLikeStack =
      correlationId !== undefined || (stackOrCorrelationId?.includes('\n') ?? false);
    const stack = secondLooksLikeStack ? stackOrCorrelationId : undefined;
    const cid = secondLooksLikeStack ? correlationId : stackOrCorrelationId;
    const base = formatMessage(message, cid);
    if (stack === undefined) {
      super.error(base);
      return;
    }
    super.error(base, sanitizeString(String(stack)).slice(0, 2000));
  }

  /** Lowest-volume diagnostics (per-attempt traces, payloads summaries). */
  verbose(message: unknown, correlationId?: string): void {
    if (!isEnabled('debug')) return;
    super.verbose(formatMessage(message, correlationId));
  }

  /** Process cannot continue (boot failure, uncaughtException) — maps to Nest fatal. */
  fatal(message: unknown, correlationId?: string): void {
    super.fatal(formatMessage(message, correlationId));
  }

  /** Returns a bound logger that always prefixes the given correlation id. */
  withCorrelationId(correlationId: string): Pick<AppLogger, 'debug' | 'verbose' | 'info' | 'log' | 'warn' | 'error' | 'fatal'> {
    return {
      debug: (m: unknown) => this.debug(m, correlationId),
      verbose: (m: unknown) => this.verbose(m, correlationId),
      info: (m: unknown) => this.info(m, correlationId),
      log: (m: unknown) => this.log(m, correlationId),
      warn: (m: unknown) => this.warn(m, correlationId),
      error: (m: unknown, stack?: string) => this.error(m, stack, correlationId),
      fatal: (m: unknown) => this.fatal(m, correlationId),
    };
  }
}
