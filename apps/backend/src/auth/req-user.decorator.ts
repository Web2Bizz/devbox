import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { readIdentity } from './identity.service';
import type { RequestIdentity } from './identity.service';

export type { RequestIdentity };

/**
 * @ReqUser() — request identity attached by JwtAuthGuard.
 * Fail-closed: no attached identity (missing/malformed user) → 401
 * `unauthorized` — there is no mock/`default` fallback.
 */
export const ReqUser: ReturnType<typeof createParamDecorator> = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestIdentity => {
    const request: unknown = context.switchToHttp().getRequest();
    const identity: RequestIdentity | null = readIdentity(request);
    if (!identity) {
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'Authentication required',
      });
    }
    return identity;
  },
);
