import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ApiError } from '../contracts.js';
import { AppLogger } from './app-logger.service.js';
import { ExternalServiceError } from './external/external-error.js';

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; cause?: unknown };
  if (e.name === 'AbortError') return true;
  if (e.code === 20 || e.code === '20') return true;
  if (e.cause && typeof e.cause === 'object') {
    const c = e.cause as { name?: unknown; code?: unknown };
    if (c.name === 'AbortError' || c.code === 20 || c.code === '20') return true;
  }
  return false;
}

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
  private readonly logger = new AppLogger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<{
      status: (code: number) => {
        json: (body: unknown) => void;
        setHeader?: (name: string, value: string) => void;
      };
      setHeader: (name: string, value: string) => void;
    }>();
    const req = ctx.getRequest<{
      headers: Record<string, string | string[] | undefined>;
      correlationId?: string;
      destroyed?: boolean;
    }>();

    const incoming = req.headers?.['x-correlation-id'];
    const correlationId =
      req.correlationId ??
      (Array.isArray(incoming) ? incoming[0] : incoming) ??
      randomUUID();

    // AbortError on an already-closed downstream (SSE disconnect after
    // flushHeaders: req.destroyed / headersSent) — штатный обрыв, тихо
    // выходим без stack и без записи в ответ. AbortError на живом
    // соединении (напр. fetch-таймаут opencode → EXTERNAL_TIMEOUT) —
    // НЕ глотаем: пропускаем дальше как internal_error/ExternalServiceError
    // чтобы фронт получил 503/504, а не зависший 200 undefined.
    if (isAbortError(exception)) {
      const rawRes = res as unknown as {
        headersSent?: boolean;
        destroyed?: boolean;
        writableEnded?: boolean;
      };
      const gone =
        req.destroyed === true ||
        rawRes.headersSent === true ||
        rawRes.destroyed === true ||
        rawRes.writableEnded === true;
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
      res.setHeader('x-correlation-id', correlationId);
    } catch {
      // headers already sent — ignore
    }

    if (exception instanceof ExternalServiceError) {
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
      // (proxy /api/v1/* and the /api/opencode/* surface throw
      // EXTERNAL_UNAVAILABLE when the opencode server is unreachable —
      // no mock 200s).
      // Logging: normal-path one-liner with service/operation/status/code,
      // no stack, no URL/body/Bearer (AppLogger sanitizes); cause/stack (if
      // any) goes to debug only.
      if (exception.httpStatus === 429 || exception.httpStatus >= 500) {
        try {
          res.setHeader('Retry-After', '30');
        } catch {
          // headers already sent — ignore
        }
      }
      try {
        const line =
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
              `code=${exception.code} detail=${String(
                exception.cause instanceof Error
                  ? (exception.cause.stack ?? exception.cause.message)
                  : exception.cause,
              ).slice(0, 2000)}`,
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
      res.status(exception.httpStatus).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse() as
        | string
        | { code?: string; message?: string | string[]; error?: string };
      let code = statusToCode(status);
      let message: string;
      if (typeof response === 'string') {
        message = response;
      } else if (response && typeof response === 'object') {
        if (typeof response.code === 'string') code = response.code;
        const raw = response.message ?? response.error ?? exception.message;
        message = Array.isArray(raw) ? raw.join('; ') : String(raw);
      } else {
        message = exception.message;
      }
      // Never leak internals on 500 — generic envelope like the node:http build.
      if (status >= 500) message = 'Unexpected server error';
      // Normal path: one-liner with status/code, no stack, no body/headers.
      try {
        const line = `[http] handled status=${status} code=${code}`;
        if (status >= 500) {
          this.logger.error(line, correlationId);
          this.logger.debug(
            `[http] cause status=${status} code=${code} detail=${String(
              (exception as Error)?.stack ?? (exception as Error)?.message ?? String(exception),
            ).slice(0, 2000)}`,
            correlationId,
          );
        } else {
          this.logger.warn(line, correlationId);
        }
      } catch {
        // ignore logging failures
      }
      const body: ApiError = { code, message, correlationId };
      res.status(status).json(body);
      return;
    }

    // Unknown error — fixed one-liner at error (no stack, no secrets);
    // sanitized detail goes to debug only, generic envelope on the wire.
    try {
      this.logger.error('[http] unhandled status=500 code=internal_error', correlationId);
      this.logger.debug(
        `[http] unhandled cause detail=${String(
          (exception as Error)?.stack ?? (exception as Error)?.message ?? String(exception),
        ).slice(0, 2000)}`,
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
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}
