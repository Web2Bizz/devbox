/**
 * db/exceptions/pg-transient — ЕДИНСТВЕННЫЙ pg transient-предикат в репо.
 *
 * Раньше дублировался: db-circuit.util.ts (isPgTransientConnectionError) +
 * retry.ts (isPgTransientLike) с расходящимися наборами кодов/текстов и
 * двумя копиями обхода `.cause`. Теперь один источник:
 * - PG_TRANSIENT_CODES / PG_TRANSIENT_MESSAGE_PARTS — канон;
 * - isPgTransientConnectionError — строгий pg-класс (dropped socket /
 *   refusing-or-restarting server, SQLSTATE 08xxx/57P0x/53300,
 *   "connection terminated" тексты, через `.cause`-цепочку);
 * - isNetworkLike — более широкий сетевой класс для retry (fetch failed,
 *   ENOTFOUND, socket hang up …) поверх pg-класса.
 *
 * Чистый слой: без DI, без логгеров, без импортов фиче-модулей.
 * db-circuit и retry только реэкспортят/используют отсюда.
 */
import { collectCodesAndMessages, type CollectedCodesAndMessages } from "../../exceptions/app-error";

/** Node errno / pg driver / SQLSTATE коды транзиентного класса. */
export const PG_TRANSIENT_CODES: ReadonlySet<string> = new Set<string>([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "08000",
  "08003",
  "08006",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

/** Фрагменты сообщений (lowercased) транзиентного pg-дропа. */
export const PG_TRANSIENT_MESSAGE_PARTS: ReadonlyArray<string> = [
  "econnreset",
  "etimedout",
  "epipe",
  "econnrefused",
  "econnaborted",
  "ehostunreach",
  "enetunreach",
  "eai_again",
  "connection reset by peer",
  "socket hang up",
  // node-postgres codeless `Error('Connection terminated unexpectedly')`
  // (pg/lib/client.js); drizzle-orm оборачивает как
  // `DrizzleQueryError('Failed query: …')` с pg-ошибкой на `.cause`.
  "connection terminated",
  "connection ended",
  "terminating connection",
  "server closed the connection",
  "terminated by administrator",
  "remaining connection slots",
  "too many connections",
  "could not connect to server",
];

/** Сетевые тексты шире pg-класса (только для retry, не для keep-alive). */
const NETWORK_MESSAGE_PARTS: ReadonlyArray<string> = [
  "fetch failed",
  "enotfound",
  "network",
  "socket hang up",
];

/**
 * True ТОЛЬКО для транзиентного pg connection-класса (см. выше).
 * Используется дважды: withRetry-предикат idempotent DAL-чтений и
 * uncaughtException keep-alive класс в main.ts (дропнутый pg-сокет
 * вне request-контекста не должен ронять процесс).
 */
export function isPgTransientConnectionError(error: unknown): boolean {
  const collected: CollectedCodesAndMessages =
    collectCodesAndMessages(error);
  for (const code of collected.codes) {
    if (PG_TRANSIENT_CODES.has(code)) return true;
  }
  for (const message of collected.messages) {
    for (const part of PG_TRANSIENT_MESSAGE_PARTS) {
      if (message.includes(part)) return true;
    }
  }
  return false;
}

/**
 * Более широкий сетевой класс для isRetryableError: pg-транзиент ИЛИ
 * fetch failed / ENOTFOUND / network. AbortError сюда НЕ входит
 * (таймауты решает isTimeoutError в external-error).
 */
export function isNetworkLikeError(error: unknown): boolean {
  if (isPgTransientConnectionError(error)) return true;
  const collected: CollectedCodesAndMessages =
    collectCodesAndMessages(error);
  for (const message of collected.messages) {
    for (const part of NETWORK_MESSAGE_PARTS) {
      if (message.includes(part)) return true;
    }
  }
  return false;
}
