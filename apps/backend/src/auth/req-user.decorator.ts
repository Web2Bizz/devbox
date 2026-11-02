import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { readIdentity } from './identity.service';
import type { RequestIdentity } from './identity.service';

export type { RequestIdentity };

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'unauthorized',
    message: 'Authentication required',
  });
}

/**
 * @ReqUser() — request identity attached by JwtAuthGuard.
 * Fail-closed: no attached identity (missing/malformed user) → 401
 * `unauthorized` — there is no mock/`default` fallback.
 */
export const ReqUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestIdentity => {
    const req = ctx.switchToHttp().getRequest();
    const identity = readIdentity(req);
    if (!identity) throw unauthorized();
    return identity;
  },
);
