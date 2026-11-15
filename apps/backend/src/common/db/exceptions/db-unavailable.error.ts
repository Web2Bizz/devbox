/**
 * db/exceptions/db-unavailable — типизированная ошибка недоступности Postgres.
 *
 * Единственное место маппинга PG/drizzle → класс (раньше логика жила в
 * DbService.dbUnavailable + размазывалась try/catch по ~30 сервисам).
 * Модули только кидают/пробрасывают — предикаты не дублируют.
 *
 * Чистый слой: без импортов фиче-модулей и DbService (цикл запрещён).
 * DbService.dbUnavailable делегирует сюда, сохраняя сигнатуру для
 * существующих ~100 call sites.
 */
import { AppError } from "../../exceptions/app-error";
import { ExternalServiceError } from "../../external/external-error";

/** Фиксированное 503-сообщение (зеркало FIXED_MESSAGES.EXTERNAL_UNAVAILABLE). */
export const DB_UNAVAILABLE_MESSAGE: string =
  "сервис временно недоступен, повторите позже";

/**
 * Already-logged маркер: один Postgres-сбой логируется ровно один раз,
 * даже когда проходит через вложенные `dbUnavailable` (sessions.create →
 * projects.getOrThrow). Ближайшая к драйверу граница логирует, внешние
 * пробрасывают молча.
 */
const loggedDbErrors: WeakSet<object> = new WeakSet<object>();

export function markDbErrorLogged(error: object): void {
  loggedDbErrors.add(error);
}

export function isDbErrorLogged(error: unknown): boolean {
  return typeof error === "object" && error !== null
    ? loggedDbErrors.has(error)
    : false;
}

export class DbUnavailableError extends ExternalServiceError {
  constructor(operation: string, cause?: unknown) {
    super({
      code: "EXTERNAL_UNAVAILABLE",
      service: "db",
      operation,
      message: DB_UNAVAILABLE_MESSAGE,
      isRetryable: true,
      cause,
    });
    this.name = "DbUnavailableError";
  }
}

/** Type-guard для main.ts keep-alive и фильтра. */
export function isDbUnavailableError(error: unknown): boolean {
  return error instanceof DbUnavailableError;
}

/**
 * Нормализует ЛЮБОЙ Postgres-сбой в DbUnavailableError (не только transient):
 * unconfigured client, refused connection, query error, timeout — всё 503.
 * Уже типизированный DbUnavailableError / ExternalServiceError service=db
 * пробрасывается как есть (back-compat: старые тесты ждут instanceof
 * ExternalServiceError, wire-контракт одинаков).
 */
export function mapDbError(
  operation: string,
  error: unknown,
): DbUnavailableError | ExternalServiceError {
  if (error instanceof DbUnavailableError) return error;
  if (error instanceof ExternalServiceError && error.service === "db")
    return error;
  return new DbUnavailableError(operation, error);
}

export type DbErrorLogger = Pick<
  { error: (message: string, correlationId?: string) => void },
  "error"
>;

/**
 * Граница DAL (совместима со старым dbUnavailable из DbService):
 * логирует один раз `[db] unavailable …` и бросает DbUnavailableError.
 * Сигнатура сохранена — существующие `dbUnavailable(op, err, logger, cid)`
 * в доменах продолжают работать без правок, но реализация теперь одна.
 */
export function throwDbUnavailable(
  operation: string,
  error: unknown,
  logger: DbErrorLogger,
  correlationId?: string,
): never {
  if (typeof error === "object" && error !== null && isDbErrorLogged(error)) {
    throw error;
  }
  const mapped: DbUnavailableError | ExternalServiceError = mapDbError(
    operation,
    error,
  );
  if (isDbErrorLogged(mapped)) throw mapped;
  try {
    logger.error(
      `[db] unavailable operation=${operation} code=EXTERNAL_UNAVAILABLE`,
      correlationId,
    );
  } catch {
    // Logging must never mask the deny.
  }
  markDbErrorLogged(mapped);
  throw mapped;
}
