/**
 * exceptions/validation — типизированная ошибка валидации границы (400).
 *
 * Покрывает «Validation / и т.п.» из постановки: модули кидают этот класс
 * вместо сырого `new BadRequestException(...)` там, где нужен machine-code.
 * ApiErrorFilter отвечает по любому AppError, так что wire — тот же envelope
 * { code, message, correlationId } без Retry-After (httpStatus < 500).
 */
import { AppError } from "./app-error";

export class ValidationError extends AppError {
  constructor(operation: string, message: string, cause?: unknown) {
    super({
      code: "VALIDATION_FAILED",
      service: "api",
      operation,
      message,
      httpStatus: 400,
      retryable: false,
      transient: false,
      cause,
    });
    this.name = "ValidationError";
  }
}
