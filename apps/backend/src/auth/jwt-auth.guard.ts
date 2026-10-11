import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AppLogger } from "../common/app-logger.service.js";
import { validateEnv } from "../env.js";
import { resolveIdentityUserId } from "./identity.service.js";
import { TokenService } from "./token.service.js";
import { UsersService } from "./users.service.js";

function bearerToken(req: unknown): string | null {
  if (typeof req !== "object" || req === null) return null;
  const headers = (req as { headers?: Record<string, unknown> }).headers;
  const raw = headers?.["authorization"];
  if (typeof raw !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

function queryUserIdOf(req: unknown): string | undefined {
  if (typeof req !== "object" || req === null) return undefined;
  const query = (req as { query?: Record<string, unknown> }).query;
  const v = query?.["userId"];
  return typeof v === "string" ? v : undefined;
}

function attach(
  req: object,
  identity: { id: string; email: string | null; mock: boolean },
): void {
  (req as { user?: unknown }).user = identity;
}

/**
 * JwtAuthGuard — Bearer access-token guard with legacy mock dual-mode.
 *
 * - Valid `Authorization: Bearer <access>` → `req.user = { id, email, mock:false }`.
 * - Otherwise, when `AUTH_LEGACY_MOCK_FALLBACK` is on (dev default + boot WARN),
 *   the old `x-user-id` / `?userId` mock identity is attached (`mock:true`) so
 *   pre-auth e2e (github/workspaces) keeps passing; otherwise 401.
 * - 401 envelope code is `unauthorized` (frozen shape { code, message,
 *   correlationId }); login/refresh use `invalid_credentials` instead.
 * - AppLogger only, fixed messages, secrets never logged.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly logger: AppLogger = new AppLogger("JwtAuthGuard"),
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    let env;
    try {
      env = validateEnv(process.env);
    } catch {
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication is not configured",
      });
    }

    const token = bearerToken(req);
    const correlationId = (req as { correlationId?: string }).correlationId;
    if (token) {
      const claims = this.tokens.verifyAccess(token, env.jwtAccessSecret);
      if (claims) {
        attach(req, { id: claims.sub, email: claims.email, mock: false });
        return true;
      }
      // Fixed event only — never the token value.
      this.logger.debug("[auth] bearer verify failed", correlationId);
    }

    if (env.authLegacyMockFallback) {
      const mockId = resolveIdentityUserId(req, queryUserIdOf(req));
      const known = await this.users.findById(mockId, correlationId);
      attach(
        req,
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
