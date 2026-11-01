import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";

/**
 * NoIndexInterceptor — sets `X-Robots-Tag: noindex` on private responses
 * (Card 6 privacy: crawlers must never index per-user/org data).
 *
 * Applied pointwise (class-level `@UseInterceptors`) on the private
 * controllers only — UsersController, OrganizationsController,
 * ProjectsController, SessionsController, ChatsController,
 * ProjectFilesController — never globally (public surfaces like /health
 * and the registry probes stay indexable/crawlable as before). The header
 * is set before the handler runs, so error envelopes (403/404/503) on the
 * same response object carry it too.
 */
@Injectable()
export class NoIndexInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    try {
      context
        .switchToHttp()
        .getResponse<{ setHeader: (name: string, value: string) => void }>()
        .setHeader("X-Robots-Tag", "noindex");
    } catch {
      // headers already sent (SSE disconnect) — ignore
    }
    return next.handle();
  }
}
