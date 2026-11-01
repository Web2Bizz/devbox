import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      correlationId?: string;
    }>();
    const res = context.switchToHttp().getResponse<{
      setHeader: (name: string, value: string) => void;
    }>();
    const incoming = req.headers['x-correlation-id'];
    const correlationId =
      (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    return next.handle();
  }
}
