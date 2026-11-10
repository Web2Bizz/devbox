import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AppLogger } from "@common/logger";
import { validateEnv, type AppEnv } from "@common/env/env";
import { resolveIdentityUserId, type RequestIdentity } from "./identity.service";
import { TokenService, type AccessClaims } from "./token.service";
import { UsersService } from "@users/users.service";
import type { StoredUser } from "@users/users.types";

/** Request slice the guard reads/writes (headers, query, identity, correlation id). */
type GuardedRequest = {
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  user?: unknown;
  correlationId?: string;
};

function bearerToken(request: unknown): string | null {
  if (typeof request !== "object" || request === null) return null;
  const headers: Record<string, unknown> | undefined = (
    request as { headers?: Record<string, unknown> }
  ).headers;
  const raw: unknown = headers?.["authorization"];
  if (typeof raw !== "string") return null;
  const match: RegExpExecArray | null = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match ? match[1] : null;
}

function queryUserIdOf(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const query: Record<string, unknown> | undefined = (
    request as { query?: Record<string, unknown> }
  ).query;
  const value: unknown = query?.["userId"];
  return typeof value === "string" ? value : undefined;
}

function attach(request: object, identity: RequestIdentity): void {
  (request as { user?: unknown }).user = identity;
}

/**
 * JwtAuthGuard — Bearer access-token guard with legacy mock dual-mode.
 *
 * - Valid `Authorization: Bearer <access>` → `req.user = { id, email, mock:false }`.
 * - Otherwise, only when `AUTH_LEGACY_MOCK_FALLBACK` is explicitly on
 *   (local-dev opt-in + boot WARN, never production; strict default off),
 *   the old `x-user-id` / `?userId` mock identity is attached (`mock:true`);
 *   otherwise 401.
 * - 401 envelope code is `unauthorized` (frozen shape { code, message,
 *   correlationId }); login/refresh use `invalid_credentials` instead.
 * - AppLogger only, fixed messages, secrets never logged.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly logger: AppLogger = new AppLogger(JwtAuthGuard.name),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: GuardedRequest = context.switchToHttp().getRequest<GuardedRequest>();
    let env: AppEnv;
    try {
      env = validateEnv(process.env);
    } catch {
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication is not configured",
      });
    }

    const token: string | null = bearerToken(request);
    const correlationId: string | undefined = request.correlationId;
    if (token) {
      const claims: AccessClaims | null = this.tokens.verifyAccess(
        token,
        env.jwtAccessSecret,
      );
      if (claims) {
        attach(request, { id: claims.sub, email: claims.email, mock: false });
        return true;
      }
      // Fixed event only — never the token value.
      this.logger.debug("[auth] bearer verify failed", correlationId);
    }

    if (env.authLegacyMockFallback) {
      const mockId: string = resolveIdentityUserId(request, queryUserIdOf(request));
      const known: StoredUser | null = await this.users.findById(mockId, correlationId);
      attach(
        request,
        known
          ? { id: known.id, email: known.email, mock: false }
          : { id: mockId, email: null, mock: true },
      );
      this.logger.debug("[auth] legacy mock identity fallback", correlationId);
      return true;
    }

    throw new UnauthorizedException({
      code: "unauthorized",
      message: "Authentication required",
    });
  }
}
