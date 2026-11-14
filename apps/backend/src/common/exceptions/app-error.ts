/**
 * exceptions/app-error — единый базовый класс всех типизированных ошибок backend.
 *
 * SCOPE: Common — чистый слой без DI, логгеров и импортов фиче-модулей
 * (common/exceptions не импортирует домены — только домены импортируют его).
 *
 * Зачем: раньше каждый модуль дублировал предикаты (isPgTransient в
 * db-circuit + isPgTransientLike в retry, ручной `code === 'EXTERNAL_*'`
 * в main.ts и ApiErrorFilter только для ExternalServiceError). Теперь один
 * AppError { code, service, operation, httpStatus, retryable/transient,
 * cause } + один обход `.cause`-цепочки. Глобальный scope:
 * - ApiErrorFilter отвечает по любому AppError (envelope + Retry-After);
 * - main.ts uncaughtException/unhandledRejection решает fate по тем же
 *   helpers (keep-alive только для retryable outage-класса);
 * - DbService pool 'error' только логирует, никогда не бросает.
 *
 * Модули (users, organizations, sessions …) только кидают типизированные
 * ошибки (DbUnavailableError / ExternalServiceError / …) — предикаты не
 * дублируют, маппинг PG/drizzle → классы живёт в одном месте
 * (db/exceptions/pg-transient + db/exceptions/db-unavailable).
 */

/** Машиночитаемый код ошибки (wire-совместим с существующим контрактом). */
export type AppErrorCode =
  | "EXTERNAL_TIMEOUT"
  | "EXTERNAL_UNAVAILABLE"
  | "EXTERNAL_RATE_LIMITED"
  | "EXTERNAL_UPSTREAM_5XX"
  | "EXTERNAL_UNAUTHORIZED"
  | "EXTERNAL_BAD_REQUEST"
  | "EXTERNAL_NOT_FOUND"
  | "GITHUB_AUTH"
  | "VALIDATION_FAILED"
  | "INTERNAL_ERROR";

export type AppErrorOptions = {
  code: AppErrorCode;
  /** Логический сервис: 'db' | 'storage' | 'opencode' | 'github' | … */
  service: string;
  /** Логическая операция: 'checkDb' | 'getSession' | … */
  operation: string;
  /** Фиксированное человекочитаемое сообщение (без секретов, без echo). */
  message: string;
  /** HTTP-статус для ApiErrorFilter (по умолчанию из кода). */
  httpStatus?: number;
  /** Повтор клиентом осмыслен (429 / 5xx outage-класс). */
  retryable?: boolean;
  /** Транзиентный класс (пересоздание/ретрай бэкенда поможет). */
  transient?: boolean;
  /** Исходная причина — никогда не уходит на wire, только в debug. */
  cause?: unknown;
};

/** HTTP-статус по умолчанию для каждого кода — канонический маппинг
 * AppErrorCode → HTTP status (единственный в репо: external/httpStatusFor
 * переиспользует его как дефолт, upstream-passthrough — только поверх). */
export function httpStatusForAppCode(code: AppErrorCode): number {
  switch (code) {
    case "EXTERNAL_RATE_LIMITED":
      return 429;
    case "EXTERNAL_TIMEOUT":
      return 504;
    case "EXTERNAL_UPSTREAM_5XX":
      return 502;
    case "GITHUB_AUTH":
      return 401;
    case "EXTERNAL_BAD_REQUEST":
      return 400;
    case "EXTERNAL_NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
      return 400;
    case "EXTERNAL_UNAUTHORIZED":
    case "EXTERNAL_UNAVAILABLE":
    case "INTERNAL_ERROR":
    default:
      return 503;
  }
}

function defaultAppRetryable(code: AppErrorCode): boolean {
  switch (code) {
    case "EXTERNAL_TIMEOUT":
    case "EXTERNAL_RATE_LIMITED":
    case "EXTERNAL_UPSTREAM_5XX":
    case "EXTERNAL_UNAVAILABLE":
      return true;
    default:
      return false;
  }
}

/**
 * Базовый класс. Расширяется конкретными ошибками
 * (DbUnavailableError, StorageUnavailableError, ExternalServiceError …).
 * `cause` хранится, но никогда не сериализуется в envelope.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly service: string;
  readonly operation: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly transient: boolean;
  readonly cause?: unknown;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = new.target.name;
    this.code = options.code;
    this.service = options.service;
    this.operation = options.operation;
    this.httpStatus =
      options.httpStatus ?? httpStatusForAppCode(options.code);
    this.retryable = options.retryable ?? defaultAppRetryable(options.code);
    this.transient = options.transient ?? this.retryable;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Совместимость с ExternalServiceError.isRetryable полем. */
  get isRetryable(): boolean {
    return this.retryable;
  }
}

/** Type-guard для глобальных обработчиков (фильтр + main.ts). */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Форма сырой ошибки для обхода `.cause`-цепочки. */
export type CauseChainLink = {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
};

/** Форма звена БЕЗ вложенной причины — тип одноуровневого `cause`. */
export type CauseWithoutCause = Omit<CauseChainLink, "cause">;

/** Именованный результат обхода `.cause`-цепочки (без поля cause). */
export type CollectedCodesAndMessages = {
  codes: Array<string>;
  messages: Array<string>;
};

/**
 * Единственный обход `.cause`-цепочки в репо (раньше дублировался в
 * db-circuit.util.ts и retry.ts): собирает все `code` (uppercased) и
 * `message` (lowercased) от ошибки и вложенных причин (drizzle оборачивает
 * драйверный throw как `DrizzleQueryError { cause }`, ExternalServiceError /
 * AppError несут `cause` тоже). Защита от циклов через WeakSet-образный Set.
 */
export function collectCodesAndMessages(
  error: unknown,
): CollectedCodesAndMessages {
  const codes: Array<string> = [];
  const messages: Array<string> = [];
  let current: unknown = error;
  const seen: Set<object> = new Set<object>();
  while (typeof current === "object" && current !== null) {
    if (seen.has(current)) break;
    seen.add(current);
    const record: CauseChainLink = current as CauseChainLink;
    if (typeof record.code === "string" && record.code.length > 0) {
      codes.push(record.code.toUpperCase());
    }
    if (typeof record.message === "string" && record.message.length > 0) {
      messages.push(record.message.toLowerCase());
    }
    current = record.cause;
  }
  return { codes, messages };
}

/** Abort-сигнал (SSE-обрыв downstream): тихий класс, не outage.
 * Канон для фильтра (api-error.filter) и process-level fate (main.ts).
 * SSE-транспорт внутри relaySse использует свой isSseAbort (см.
 * common/sse/sse-relay.ts) — уже, только числовой код 20, строковый '20'
 * не считает абортом. */
export function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value: CauseChainLink = error as CauseChainLink;
  if (value.name === "AbortError" || value.code === 20 || value.code === "20")
    return true;
  if (value.cause && typeof value.cause === "object") {
    const cause: CauseWithoutCause = value.cause as CauseWithoutCause;
    if (
      cause.name === "AbortError" ||
      cause.code === 20 ||
      cause.code === "20"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Db-outage класс для process-level fate: уже замапленный AppError
 * service=db (любой наследник) — тот же outage, что уже ответил 503
 * через ApiErrorFilter, процесс живёт.
 */
export function isDbOutageError(error: unknown): boolean {
  return isAppError(error) && error.service === "db";
}
