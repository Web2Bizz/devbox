import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';

/** Minimal request surface the interceptor annotates with the correlation id. */
type CorrelationRequest = {
  headers: Record<string, string | Array<string> | undefined>;
  correlationId?: string;
};

/** Minimal response surface the interceptor stamps the correlation id on. */
type CorrelationResponse = {
  setHeader: (name: string, value: string) => void;
};

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request: CorrelationRequest =
      context.switchToHttp().getRequest<CorrelationRequest>();
    const response: CorrelationResponse =
      context.switchToHttp().getResponse<CorrelationResponse>();
    const incomingHeader: string | Array<string> | undefined =
      request.headers['x-correlation-id'];
    const correlationId: string =
      (Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader) ?? randomUUID();
    request.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    return next.handle();
  }
}
