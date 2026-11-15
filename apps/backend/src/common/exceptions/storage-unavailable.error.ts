/**
 * exceptions/storage-unavailable — типизированная ошибка unconfigured REPOS_ROOT.
 *
 * Единственное место маппинга storage-отказа → класс (раньше жило в
 * common/storage/storage-unavailable.ts с дублированием сообщения/логики).
 * Тонкая обёртка: фиксированное сообщение + service=storage, остальное —
 * общий AppError. Без импортов фиче-модулей.
 */
import { ExternalServiceError } from "../external/external-error";

/** Фиксированное 503-сообщение (зеркало dbUnavailable). */
export const STORAGE_UNAVAILABLE_MESSAGE: string =
  "сервис временно недоступен, повторите позже";

export class StorageUnavailableError extends ExternalServiceError {
  constructor(operation: string, cause?: unknown) {
    super({
      code: "EXTERNAL_UNAVAILABLE",
      service: "storage",
      operation,
      message: STORAGE_UNAVAILABLE_MESSAGE,
      isRetryable: true,
      cause,
    });
    this.name = "StorageUnavailableError";
  }
}

export function isStorageUnavailableError(error: unknown): boolean {
  return error instanceof StorageUnavailableError;
}
