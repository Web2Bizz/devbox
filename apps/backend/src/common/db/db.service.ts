import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { type AppEnv, validateEnv } from "../env/env";
import { AppLogger } from "../logger";
import { ExternalServiceError } from "../external/external-error";

export type DbClient = ReturnType<typeof drizzle>;

/** Fixed 503 message for Postgres outages (mirrors FIXED_MESSAGES.EXTERNAL_UNAVAILABLE). */
const DB_UNAVAILABLE_MESSAGE: string = "сервис временно недоступен, повторите позже";

/**
 * Already-logged marker — a Postgres failure must produce exactly one
 * `[db] unavailable ...` error line even when it propagates through nested
 * service calls (e.g. sessions.create → projects.getOrThrow), each of which
 * funnels through this helper. The innermost boundary (closest to the
 * driver throw, carrying the caller's correlationId) logs; outer ones
 * rethrow silently.
 */
const loggedDbErrors: WeakSet<object> = new WeakSet<object>();

/**
 * Normalizes any Postgres failure (unconfigured client, refused connection,
 * query error) into a 503 EXTERNAL_UNAVAILABLE with one error log line.
 * Never carries the connection string, credentials, or driver detail to the
 * wire — `cause` stays off the envelope (ApiErrorFilter serializes
 * code/message/correlationId only, plus Retry-After 30 for 503s).
 */
export function dbUnavailable(
  operation: string,
  error: unknown,
  logger: Pick<AppLogger, "error">,
  correlationId?: string,
): never {
  if (
    error instanceof ExternalServiceError &&
    error.service === "db" &&
    loggedDbErrors.has(error)
  ) {
    throw error;
  }
  logger.error(
    `[db] unavailable operation=${operation} code=EXTERNAL_UNAVAILABLE`,
    correlationId,
  );
  if (error instanceof ExternalServiceError) {
    loggedDbErrors.add(error);
    throw error;
  }
  const wrapped: ExternalServiceError = new ExternalServiceError({
    code: "EXTERNAL_UNAVAILABLE",
    service: "db",
    operation,
    message: DB_UNAVAILABLE_MESSAGE,
    isRetryable: true,
    cause: error,
  });
  loggedDbErrors.add(wrapped);
  throw wrapped;
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
    this.pool = new Pool({ connectionString: databaseUrl });
    this.pool.on("error", (error: Error): void => {
      // Message + sanitized stack — connection string never logged
      // (AppLogger also scrubs live secrets).
      this.logger.error(`[db] pool error: ${error.message}`, error.stack);
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
      throw new ExternalServiceError({
        code: "EXTERNAL_UNAVAILABLE",
        service: "db",
        operation: "client",
        message: DB_UNAVAILABLE_MESSAGE,
        isRetryable: true,
      });
    }
    return db;
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
      throw new ExternalServiceError({
        code: "EXTERNAL_UNAVAILABLE",
        service: "db",
        operation: "listen",
        message: DB_UNAVAILABLE_MESSAGE,
        isRetryable: true,
      });
    }
    const client: PoolClient = await pool.connect();
    try {
      await client.query(`LISTEN "${channel}"`);
    } catch (error) {
      client.release();
      throw error;
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
   * an outage, not a mode).
   */
  async checkDb(): Promise<"up" | "down"> {
    if (!this.db) {
      this.logger.error(
        "[db] unavailable operation=checkDb code=EXTERNAL_UNAVAILABLE",
      );
      return "down";
    }
    const startedAt: number = Date.now();
    this.logger.debug(
      "[external] start service=db operation=checkDb method=SELECT1",
    );
    try {
      await this.db.execute(sql`SELECT 1`);
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
      return "down";
    }
  }
}
