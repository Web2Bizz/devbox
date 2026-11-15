import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { type AppEnv, validateEnv } from "../env/env";
import {
  DEFAULT_EXTERNAL_RETRY_BASE_DELAY_MS,
  DEFAULT_EXTERNAL_RETRY_MAX_DELAY_MS,
} from "../env/env";
import { AppLogger } from "../logger";
import { isAppError } from "../exceptions/app-error";
import { isRetryableError, withRetry } from "../external/retry";
import { DbUnavailableError } from "./exceptions/db-unavailable.error";
import { throwDbUnavailable } from "./exceptions/db-unavailable.error";
import {
  DB_BREAKER_COOLDOWN_MS,
  DB_POOL_CONNECTION_TIMEOUT_MS,
  DB_POOL_IDLE_TIMEOUT_MS,
  DB_POOL_KEEP_ALIVE,
  DB_POOL_KEEP_ALIVE_INITIAL_DELAY_MS,
  DB_POOL_MAX,
  DB_READ_MAX_ATTEMPTS,
  enterHalfOpen,
  initialDbBreakerState,
  nextDbBreakerState,
  shouldHalfOpenProbe,
  shouldShortCircuit,
  type DbBreakerState,
  type DbResilienceStats,
} from "./utils/db-circuit";

export type DbClient = ReturnType<typeof drizzle>;

/**
 * Normalizes any Postgres failure (unconfigured client, refused connection,
 * query error) into a 503 EXTERNAL_UNAVAILABLE with one error log line.
 * Never carries the connection string, credentials, or driver detail to the
 * wire — `cause` stays off the envelope (ApiErrorFilter serializes
 * code/message/correlationId only, plus Retry-After 30 for 503s).
 *
 * Реализация — тонкий back-compat фасад над единым
 * common/db/exceptions/db-unavailable (throwDbUnavailable): один маппинг
 * PG/drizzle → DbUnavailableError на весь backend, без дублей по модулям.
 * Сигнатура сохранена — ~100 call sites в доменах не меняются.
 */
export function dbUnavailable(
  operation: string,
  error: unknown,
  logger: Pick<AppLogger, "error">,
  correlationId?: string,
): never {
  throwDbUnavailable(operation, error, logger, correlationId);
}

/**
 * Options for DbService.executeRead (idempotent DAL reads only).
 */
export type DbReadOptions = {
  /** Traced through retry/breaker log lines. */
  correlationId?: string;
  /** Equal-jitter the backoff (default true); false → deterministic (tests). */
  jitter?: boolean;
  /** Injected clock for tests (default: setTimeout-based). */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injected clock for the breaker cooldown (default Date.now, tests pin it). */
  now?: () => number;
};

type DbRetryTuning = {
  baseDelayMs: number;
  maxDelayMs: number;
};

/** Short failure code for retry log lines (shape only — never values/secrets). */
function readErrorCode(error: unknown): string {
  if (isAppError(error)) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

/**
 * DbService — drizzle-orm + pg Pool wrapper (strict Postgres).
 *
 * No in-memory fallback anywhere: domain services (users, projects, chats,
 * sessions, github-installations) hit Postgres only. Without DATABASE_URL the
 * pool stays null, `client` throws 503 EXTERNAL_UNAVAILABLE and `checkDb`
 * reports 'down' — dependents answer 503 (Retry-After 30 via ApiErrorFilter)
 * instead of masking the outage with volatile memory state.
 */
@Injectable()
export class DbService {
  private readonly pool: Pool | null;
  private readonly db: DbClient | null;
  private breaker: DbBreakerState = initialDbBreakerState();
  private resilienceStats: DbResilienceStats = {
    name: "closed",
    consecutiveFailures: 0,
    attempts: 0,
    retries: 0,
    breakerOpens: 0,
    shortCircuits: 0,
    halfOpenProbes: 0,
  };

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger = new AppLogger(DbService.name),
  ) {
    const databaseUrl: string = this.resolveDatabaseUrl();
    if (!databaseUrl) {
      this.pool = null;
      this.db = null;
      // Loud at boot (no secret values) — every Postgres op 503s until configured.
      this.logger.warn(
        "[db] DATABASE_URL is not configured — Postgres operations will answer 503 EXTERNAL_UNAVAILABLE",
      );
      return;
    }
    // Explicit pool tunables (every value stated — never driver defaults, so
    // an outage behaves the same on every machine): max connections, idle
    // eviction, connect timeout, TCP keep-alive. Values live in
    // utils/db-circuit (DB_POOL_*) — no secrets, safe to log.
    const poolConfig: PoolConfig = {
      connectionString: databaseUrl,
      max: DB_POOL_MAX,
      idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
      keepAlive: DB_POOL_KEEP_ALIVE,
      keepAliveInitialDelayMillis: DB_POOL_KEEP_ALIVE_INITIAL_DELAY_MS,
    };
    this.pool = new Pool(poolConfig);
    this.logger.info(
      `[db] pool max=${DB_POOL_MAX} idleTimeoutMs=${DB_POOL_IDLE_TIMEOUT_MS} ` +
        `connectionTimeoutMs=${DB_POOL_CONNECTION_TIMEOUT_MS} keepAlive=${String(DB_POOL_KEEP_ALIVE)}`,
    );
    this.pool.on("error", (error: Error): void => {
      // Idle-client drop (PG restart, dead socket: `Connection terminated
      // unexpectedly`, ECONNRESET, 57P01/57P02…). This listener exists so the
      // EventEmitter never throws for an 'error' event with no handler (that
      // throw lands in uncaughtException and used to kill the process).
      // In-flight queries fail independently through executeRead (retry +
      // breaker → 503 EXTERNAL_UNAVAILABLE, recovery via half-open probe),
      // so this handler only logs — it never throws and never touches the
      // breaker (one idle drop without an operation context must not trip
      // the 30s short-circuit for live reads).
      try {
        // Message + sanitized stack — connection string never logged
        // (AppLogger also scrubs live secrets).
        this.logger.error(`[db] pool error: ${error.message}`, error.stack);
      } catch {
        // Logging must never take the process down — swallow by design.
      }
    });
    this.db = drizzle(this.pool);
  }

  private resolveDatabaseUrl(): string {
    // Prefer validated env (fail-fast semantics, no secret logging).
    try {
      const env: AppEnv = validateEnv(process.env);
      if (env.databaseUrl) return env.databaseUrl;
    } catch {
      // readonly-исключение: fall through к сырому ConfigService-значению только
      // для чтения конфига (trimmed, never logged); пусто → pool=null + boot WARN
      // + 503 EXTERNAL_UNAVAILABLE на каждый Postgres-op (никакого тихого успеха).
    }
    const raw: string =
      this.config.get<string>("DATABASE_URL") ??
      (process.env.DATABASE_URL as string | undefined) ??
      "";
    return raw.trim();
  }

  /**
   * Live drizzle client. Throws 503 EXTERNAL_UNAVAILABLE when Postgres is
   * unconfigured (no DATABASE_URL) — never null, no memory fallback.
   * Callers funnel the throw through `dbUnavailable` so the failure is
   * logged once with the request correlationId.
   */
  get client(): DbClient {
    const db: DbClient | null = this.db;
    if (!db) {
      throw new DbUnavailableError("client");
    }
    return db;
  }

  /**
   * Resilient idempotent DAL read (SELECTs such as users.findById): breaker
   * guard → bounded retry (5 attempts, backoff+jitter) → breaker accounting.
   *
   * - Open breaker inside the cooldown short-circuits to 503
   *   EXTERNAL_UNAVAILABLE without touching Postgres (Retry-After 30 comes
   *   from ApiErrorFilter — the wire contract is unchanged).
   * - Retry covers ONLY retryable failures (pg transient drops — codeless
   *   `Connection terminated unexpectedly`, refused/shutdown codes,
   *   SQLSTATE 08xxx/57P0x via the drizzle `.cause` chain, timeouts,
   *   429/5xx-shaped — isRetryableError); anything else fails fast
   *   on attempt 1. Writes must NOT use this helper (single attempt).
   * - Retries log at warn (service/operation/attempt only, no secrets); the
   *   final failure rethrows RAW so the caller funnels it through
   *   dbUnavailable exactly once (one error line, 503 downstream).
   * - Recovery needs no restart: a half-open trial after the 30s cooldown
   *   closes the breaker on the first success.
   */
  async executeRead<T>(
    operation: string,
    read: (attempt: number) => Promise<T>,
    options: DbReadOptions = {},
  ): Promise<T> {
    const correlationId: string | undefined = options.correlationId;
    const now: () => number = options.now ?? Date.now;
    const nowMs: number = now();
    if (shouldShortCircuit(this.breaker, nowMs)) {
      this.resilienceStats.shortCircuits += 1;
      this.resilienceStats.name = this.breaker.name;
      this.logger.warn(
        `[db] short-circuit operation=${operation} state=open`,
        correlationId,
      );
      dbUnavailable(
        operation,
        new DbUnavailableError(operation),
        this.logger,
        correlationId,
      );
    }
    if (shouldHalfOpenProbe(this.breaker, nowMs)) {
      this.breaker = enterHalfOpen(this.breaker);
      this.resilienceStats.halfOpenProbes += 1;
      this.resilienceStats.name = this.breaker.name;
      this.logger.warn(
        `[db] half-open probe operation=${operation}`,
        correlationId,
      );
    }
    const retryTuning: DbRetryTuning = this.resolveReadRetryTuning();
    let attemptsUsed: number = 0;
    const startedAt: number = Date.now();
    try {
      const result: T = await withRetry(
        async (attempt: number): Promise<T> => {
          attemptsUsed = attempt;
          this.resilienceStats.attempts += 1;
          return read(attempt);
        },
        {
          maxAttempts: DB_READ_MAX_ATTEMPTS,
          baseDelayMs: retryTuning.baseDelayMs,
          maxDelayMs: retryTuning.maxDelayMs,
          jitter: options.jitter ?? true,
          method: "GET",
          sleep: options.sleep,
          shouldRetry: (error: unknown, attempt: number): boolean => {
            const retryable: boolean = isRetryableError(error);
            if (retryable) {
              this.logger.warn(
                `[db] retry operation=${operation} attempt=${attempt} ` +
                  `code=${readErrorCode(error)}`,
                correlationId,
              );
            }
            return retryable;
          },
        },
      );
      this.resilienceStats.retries += Math.max(attemptsUsed - 1, 0);
      this.applyBreakerOutcome("success", now(), operation, correlationId);
      this.logger.debug(
        `[db] read success operation=${operation} attempt=${attemptsUsed} ` +
          `latencyMs=${Date.now() - startedAt}`,
        correlationId,
      );
      return result;
    } catch (error) {
      this.resilienceStats.retries += Math.max(attemptsUsed - 1, 0);
      this.applyBreakerOutcome("failure", now(), operation, correlationId);
      throw error;
    }
  }

  /** Current breaker snapshot for logs/metrics (never on the wire — contract unchanged). */
  getBreakerState(): DbBreakerState {
    const snapshot: DbBreakerState = {
      name: this.breaker.name,
      consecutiveFailures: this.breaker.consecutiveFailures,
      openedAtMs: this.breaker.openedAtMs,
    };
    return snapshot;
  }

  /** Cumulative resilience counters (attempts/retries/opens/short-circuits/probes). */
  getResilienceStats(): DbResilienceStats {
    const snapshot: DbResilienceStats = { ...this.resilienceStats };
    return snapshot;
  }

  /** Test seam — resets breaker + counters (fresh state per check). */
  resetResilienceForTests(): void {
    this.breaker = initialDbBreakerState();
    this.resilienceStats = {
      name: "closed",
      consecutiveFailures: 0,
      attempts: 0,
      retries: 0,
      breakerOpens: 0,
      shortCircuits: 0,
      halfOpenProbes: 0,
    };
  }

  private resolveReadRetryTuning(): DbRetryTuning {
    try {
      const environment: AppEnv = validateEnv(process.env);
      const tuning: DbRetryTuning = {
        baseDelayMs: environment.externalRetryBaseDelayMs,
        maxDelayMs: environment.externalRetryMaxDelayMs,
      };
      return tuning;
    } catch {
      // readonly-исключение: тюнинг бэкоффа чтения (не путь записи) — дефолты
      // при невалидном env; бюджет попыток при этом фиксирован (5, см.
      // DB_READ_MAX_ATTEMPTS), запросы не маскируются под успех.
      const tuning: DbRetryTuning = {
        baseDelayMs: DEFAULT_EXTERNAL_RETRY_BASE_DELAY_MS,
        maxDelayMs: DEFAULT_EXTERNAL_RETRY_MAX_DELAY_MS,
      };
      return tuning;
    }
  }

  private applyBreakerOutcome(
    outcome: "success" | "failure",
    nowMs: number,
    operation: string,
    correlationId: string | undefined,
  ): void {
    const wasOpen: boolean =
      this.breaker.name === "open" || this.breaker.name === "half-open";
    this.breaker = nextDbBreakerState(this.breaker, outcome, nowMs);
    this.resilienceStats.name = this.breaker.name;
    this.resilienceStats.consecutiveFailures =
      this.breaker.consecutiveFailures;
    if (outcome === "failure" && this.breaker.name === "open" && !wasOpen) {
      this.resilienceStats.breakerOpens += 1;
      this.logger.error(
        `[db] breaker open operation=${operation} ` +
          `consecutiveFailures=${this.breaker.consecutiveFailures} cooldownMs=${DB_BREAKER_COOLDOWN_MS}`,
        correlationId,
      );
    }
    if (outcome === "failure" && this.breaker.name === "open" && wasOpen) {
      this.resilienceStats.breakerOpens += 1;
      this.logger.error(
        `[db] breaker re-open operation=${operation} state=half-open ` +
          `cooldownMs=${DB_BREAKER_COOLDOWN_MS}`,
        correlationId,
      );
    }
    if (outcome === "success" && wasOpen) {
      this.logger.warn(
        `[db] breaker closed operation=${operation}`,
        correlationId,
      );
    }
  }

  /**
   * Dedicated LISTEN connection from the shared pool (Postgres NOTIFY). The
   * channel is a compile-time identifier validated below (no SQL injection);
   * the payload is an opaque string the caller parses. Returns an idempotent
   * close() that UNLISTENs and releases the connection. No pool → 503
   * EXTERNAL_UNAVAILABLE (same strict-Postgres contract as `client`).
   */
  async listen(
    channel: string,
    onPayload: (payload: string) => void,
  ): Promise<{ close: () => Promise<void> }> {
    if (!/^[a-z_][a-z0-9_]*$/i.test(channel)) {
      throw new Error("listen: channel must be an identifier");
    }
    const pool: Pool | null = this.pool;
    if (!pool) {
      throw new DbUnavailableError("listen");
    }
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      throwDbUnavailable("listen.connect", error, this.logger);
    }
    try {
      await client.query(`LISTEN "${channel}"`);
    } catch (error) {
      client.release();
      throwDbUnavailable("listen.subscribe", error, this.logger);
    }
    const handler: (message: { channel: string; payload?: string }) => void = (
      message: { channel: string; payload?: string },
    ): void => {
      if (message.channel === channel) onPayload(message.payload ?? "");
    };
    client.on("notification", handler);
    let closed: boolean = false;
    return {
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        client.removeListener("notification", handler);
        try {
          await client.query(`UNLISTEN "${channel}"`);
        } finally {
          client.release();
        }
      },
    };
  }

  /**
   * Liveness probe for GET /health. 'up' on SELECT 1, 'down' otherwise —
   * never throws, never 'skipped' (an unconfigured/unreachable Postgres is
   * an outage, not a mode). Feeds the same breaker executeRead uses: an open
   * breaker short-circuits to a fast 'down' (no Postgres round-trip), and
   * probe outcomes count toward open/close like any other read.
   */
  async checkDb(): Promise<"up" | "down"> {
    if (!this.db) {
      this.logger.error(
        "[db] unavailable operation=checkDb code=EXTERNAL_UNAVAILABLE",
      );
      return "down";
    }
    const nowMs: number = Date.now();
    if (shouldShortCircuit(this.breaker, nowMs)) {
      this.resilienceStats.shortCircuits += 1;
      this.logger.warn("[db] short-circuit operation=checkDb state=open");
      return "down";
    }
    const startedAt: number = Date.now();
    this.logger.debug(
      "[external] start service=db operation=checkDb method=SELECT1",
    );
    try {
      await this.db.execute(sql`SELECT 1`);
      this.breaker = nextDbBreakerState(this.breaker, "success", Date.now());
      this.resilienceStats.name = this.breaker.name;
      this.resilienceStats.consecutiveFailures =
        this.breaker.consecutiveFailures;
      this.logger.debug(
        `[external] success service=db operation=checkDb attempt=1 latencyMs=${Date.now() - startedAt}`,
      );
      return "up";
    } catch (error) {
      // Message + sanitized stack — connection string never logged
      // (AppLogger also scrubs live secrets).
      this.logger.error(
        `[external] failure service=db operation=checkDb code=EXTERNAL_UNAVAILABLE ` +
          `latencyMs=${Date.now() - startedAt}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      const wasOpen: boolean =
        this.breaker.name === "open" || this.breaker.name === "half-open";
      this.breaker = nextDbBreakerState(this.breaker, "failure", Date.now());
      this.resilienceStats.name = this.breaker.name;
      this.resilienceStats.consecutiveFailures =
        this.breaker.consecutiveFailures;
      if (this.breaker.name === "open" && !wasOpen) {
        this.resilienceStats.breakerOpens += 1;
        this.logger.error(
          `[db] breaker open operation=checkDb ` +
            `consecutiveFailures=${this.breaker.consecutiveFailures} cooldownMs=${DB_BREAKER_COOLDOWN_MS}`,
        );
      }
      return "down";
    }
  }
}
