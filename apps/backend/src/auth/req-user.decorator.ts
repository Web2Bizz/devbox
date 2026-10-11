import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { readIdentity } from './identity.service.js';
import type { RequestIdentity } from './identity.service.js';

export type { RequestIdentity };

/**
 * @ReqUser() — request identity attached by JwtAuthGuard.
 * Throws nothing by itself; the guard guarantees presence on protected routes.
 */
export const ReqUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestIdentity => {
    const req = ctx.switchToHttp().getRequest();
    return (
      readIdentity(req) ?? {
        id: 'default',
        email: null,
        mock: true,
      }
    );
  },
);
