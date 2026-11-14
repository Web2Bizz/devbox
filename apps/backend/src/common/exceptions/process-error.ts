/**
 * exceptions/process-error — ЕДИНСТВЕННОЕ решение fate для process-level
 * ошибок (main.ts uncaughtException / unhandledRejection).
 *
 * Раньше main.ts дублировал предикаты: isPgTransientConnectionError +
 * ручная проверка `code === 'EXTERNAL_UNAVAILABLE' && service === 'db'`.
 * Теперь один вызов resolveProcessFate(error):
 * - abort → { keepAlive: true, reason: 'abort' } (тихий SSE-обрыв);
 * - pg-транзиент ИЛИ AppError service=db|storage с retryable →
 *   { keepAlive: true, reason } (outage уже ответил 503, процесс живёт);
 * - всё остальное → { keepAlive: false } (fatal + exit(1)).
 *
 * Чистый слой: только AppError-helpers + pg-transient, без DI/логгеров.
 */
import { isAbortLike, isAppError } from "./app-error";
import { isPgTransientConnectionError } from "../db/exceptions/pg-transient";

export type ProcessFate = {
  keepAlive: boolean;
  /** Короткая причина для лога (без секретов, без стека). */
  reason: "abort" | "pg-transient" | "db-outage" | "fatal";
};

export function resolveProcessFate(error: unknown): ProcessFate {
  if (isAbortLike(error)) return { keepAlive: true, reason: "abort" };
  if (isPgTransientConnectionError(error))
    return { keepAlive: true, reason: "pg-transient" };
  if (isAppError(error) && error.retryable) {
    if (error.service === "db" || error.service === "storage")
      return { keepAlive: true, reason: "db-outage" };
  }
  return { keepAlive: false, reason: "fatal" };
}
