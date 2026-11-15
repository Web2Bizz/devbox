import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ApiError } from '@rush-code/contracts';
import { AppLogger, serializeCause } from '../logger';
import { isAbortLike, isAppError } from '../exceptions/app-error';
import { isPgTransientConnectionError } from '../db/exceptions/pg-transient';

/** Minimal response surface the filter writes the envelope through. */
type FilterResponse = {
  status: (code: number) => {
    json: (body: unknown) => void;
    setHeader?: (name: string, value: string) => void;
  };
  setHeader: (name: string, value: string) => void;
};

/** Minimal request surface the filter reads (headers + correlation id). */
type FilterRequest = {
  headers: Record<string, string | Array<string> | undefined>;
  correlationId?: string;
  destroyed?: boolean;
};

/** Raw node response flags used to detect an already-closed downstream. */
type RawResponseState = {
  headersSent?: boolean;
  destroyed?: boolean;
  writableEnded?: boolean;
};

/** ArgumentsHost HTTP view (exported by the framework only via internal.d.ts). */
type HttpContext = ReturnType<ArgumentsHost['switchToHttp']>;

function statusToCode(status: number): string {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'payload_too_large';
  if (status >= 500) return 'internal_error';
  return 'request_failed';
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger: AppLogger = new AppLogger(ApiErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context: HttpContext = host.switchToHttp();
    const httpResponse: FilterResponse = context.getResponse<FilterResponse>();
    const httpRequest: FilterRequest = context.getRequest<FilterRequest>();

    const incomingHeader: string | Array<string> | undefined =
      httpRequest.headers?.['x-correlation-id'];
    const correlationId: string =
      httpRequest.correlationId ??
      (Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader) ??
      randomUUID();

    // AbortError on an already-closed downstream (SSE disconnect after
    // flushHeaders: request.destroyed / headersSent) — штатный обрыв, тихо
    // выходим без stack и без записи в ответ. AbortError на живом
    // соединении (напр. fetch-таймаут opencode → EXTERNAL_TIMEOUT) —
    // НЕ глотаем: пропускаем дальше как internal_error/ExternalServiceError
    // чтобы фронт получил 503/504, а не зависший 200 undefined.
    if (isAbortLike(exception)) {
      const rawResponse: RawResponseState = httpResponse as unknown as RawResponseState;
      const gone: boolean =
        httpRequest.destroyed === true ||
        rawResponse.headersSent === true ||
        rawResponse.destroyed === true ||
        rawResponse.writableEnded === true;
      if (gone) {
        try {
          this.logger.debug('[http] client aborted (SSE closed)', correlationId);
        } catch {
          // ignore logging failures
        }
        return;
      }
    }
    try {
      httpResponse.setHeader('x-correlation-id', correlationId);
    } catch {
      // headers already sent — ignore
    }

    if (isAppError(exception)) {
      // Typed failure — единый глобальный класс AppError (ExternalServiceError
      // — наследник для back-compat; DbUnavailableError / StorageUnavailable /
      // ValidationError — тот же путь). Wire-контракт неизменен:
      // Typed upstream failure — same { code, message, correlationId } envelope
      // (no breaking change); the machine code is the EXTERNAL_*/GITHUB_AUTH
      // code verbatim so clients can distinguish retryable upstreams.
      // Messages are fixed at construction (never carry upstream bodies or
      // secrets); 5xx upstreams intentionally keep their safe message instead
      // of the generic 'Unexpected server error'.
      // Retryable answers carry Retry-After so clients back off instead of
      // polling: 429 rate limit + any 5xx (502 passthrough / 503 unavailable /
      // 504 timeout). 4xx client states (401 invalid / 404 missing key) never
      // carry it — the fix is user action, not a retry delay.
      // EXTERNAL_UNAUTHORIZED is the exception inside the 5xx family: the
      // upstream refused the credentials we sent, so a retry can only fail
      // the same way — no Retry-After, the fix is a config change.
      // (proxy /api/v1/* and the legacy sessions transport throw
      // EXTERNAL_UNAVAILABLE when the opencode server is unreachable —
      // no mock 200s).
      // Logging: normal-path one-liner with service/operation/status/code,
      // no stack, no URL/body/Bearer (AppLogger sanitizes); cause/stack (if
      // any) goes to debug only.
      const retryableAnswer: boolean =
        exception.code !== 'EXTERNAL_UNAUTHORIZED' &&
        (exception.httpStatus === 429 || exception.httpStatus >= 500);
      if (retryableAnswer) {
        try {
          httpResponse.setHeader('Retry-After', '30');
        } catch {
          // headers already sent — ignore
        }
      }
      try {
        const line: string =
          `[http] handled service=${exception.service} operation=${exception.operation} ` +
          `status=${exception.httpStatus} code=${exception.code}`;
        if (exception.httpStatus === 429 || exception.httpStatus >= 500) {
          this.logger.error(line, correlationId);
        } else {
          this.logger.warn(line, correlationId);
        }
        if (exception.cause !== undefined) {
          this.logger.debug(
            `[http] cause service=${exception.service} operation=${exception.operation} ` +
              `code=${exception.code} detail=${serializeCause(exception.cause).slice(0, 2000)}`,
            correlationId,
          );
        }
      } catch {
        // ignore logging failures
      }
      const body: ApiError = {
        code: exception.code,
        message: exception.message,
        correlationId,
      };
      httpResponse.status(exception.httpStatus).json(body);
      return;
    }

    // Сырой PG/drizzle-сбой, не замапленный модулем (забытый dbUnavailable):
    // глобальный scope отвечает тем же 503 EXTERNAL_UNAVAILABLE + Retry-After,
    // а не generic 500. Маппинг в одном месте — модули предикаты не дублируют.
    // operation намеренно остаётся `unknown`: единственный кандидат из
    // request-контекста — req.url/route, а URL несёт query (риск секретов/PII
    // в логе), имя хендлера через host.getHandler() нестабильно между
    // транспортами и отсутствует в минимальном FilterRequest-контракте.
    // Настоящая операция уже залогирована на DAL-границе (throwDbUnavailable
    // пишет `[db] unavailable operation=<op>` до проброса сюда), так что
    // `unknown` здесь — маркер «модуль забыл dbUnavailable», а не потеря данных.
    if (isPgTransientConnectionError(exception)) {
      try {
        httpResponse.setHeader('Retry-After', '30');
      } catch {
        // headers already sent — ignore
      }
      try {
        this.logger.error(
          '[http] handled service=db operation=unknown status=503 code=EXTERNAL_UNAVAILABLE',
          correlationId,
        );
        this.logger.debug(
          `[http] cause service=db operation=unknown code=EXTERNAL_UNAVAILABLE detail=${serializeCause(exception).slice(0, 2000)}`,
          correlationId,
        );
      } catch {
        // ignore logging failures
      }
      const body: ApiError = {
        code: 'EXTERNAL_UNAVAILABLE',
        message: 'сервис временно недоступен, повторите позже',
        correlationId,
      };
      httpResponse.status(503).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status: number = exception.getStatus();
      const exceptionResponse: string | {
        code?: string;
        message?: string | Array<string>;
        error?: string;
      } = exception.getResponse() as
        | string
        | { code?: string; message?: string | Array<string>; error?: string };
      let code: string = statusToCode(status);
      let message: string;
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (exceptionResponse && typeof exceptionResponse === 'object') {
        if (typeof exceptionResponse.code === 'string') code = exceptionResponse.code;
        const rawMessage: string | Array<string> =
          exceptionResponse.message ?? exceptionResponse.error ?? exception.message;
        message = Array.isArray(rawMessage) ? rawMessage.join('; ') : String(rawMessage);
      } else {
        message = exception.message;
      }
      // Never leak internals on 500 — generic envelope like the node:http build.
      if (status >= 500) message = 'Unexpected server error';
      // Normal path: one-liner with status/code, no stack, no body/headers.
      try {
        const line: string = `[http] handled status=${status} code=${code}`;
        if (status >= 500) {
          this.logger.error(line, correlationId);
          this.logger.debug(
            `[http] cause status=${status} code=${code} detail=${serializeCause(exception).slice(0, 2000)}`,
            correlationId,
          );
        } else {
          this.logger.warn(line, correlationId);
        }
      } catch {
        // ignore logging failures
      }
      const body: ApiError = { code, message, correlationId };
      httpResponse.status(status).json(body);
      return;
    }

    // Unknown error — fixed one-liner at error (no stack, no secrets);
    // sanitized detail goes to debug only, generic envelope on the wire.
    try {
      this.logger.error('[http] unhandled status=500 code=internal_error', correlationId);
      this.logger.debug(
        `[http] unhandled cause detail=${serializeCause(exception).slice(0, 2000)}`,
        correlationId,
      );
    } catch {
      // ignore logging failures
    }
    const body: ApiError = {
      code: 'internal_error',
      message: 'Unexpected server error',
      correlationId,
    };
    httpResponse.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}
