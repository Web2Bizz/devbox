import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  InternalServerErrorException,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { AppLogger } from "../common/logger";
import { ExternalServiceError } from "../common/external/external-error";
import { ZodValidationPipe } from "../common/validation";
import { validateEnv } from "../common/env/env";
import { LocalAuthProvider } from "./auth-provider";
import {
  AuthSessionDto,
  AuthTokensDto,
  AuthUserDto,
  LoginBodyDto,
  RefreshBodyDto,
  RegisterBodyDto,
  UpdateMeBodyDto,
  loginSchema,
  refreshSchema,
  registerSchema,
  updateMeSchema,
  type LoginInput,
  type RefreshInput,
  type RegisterInput,
  type UpdateMeInput,
} from "./auth.dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { ReqUser } from "./req-user.decorator";
import type { RequestIdentity } from "./identity.service";
import { TokenService } from "./token.service";
import { UsersService, toPublicUser } from "../users/users.service";

/** httpOnly refresh cookie (read by POST /auth/refresh via body or cookie). */
export const REFRESH_COOKIE = "rush-code-refresh";
/** Readable marker for the Next middleware guard (carries no secret). */
export const AUTH_MARKER_COOKIE = "rush-code-auth";

function refreshTtlSec(): { accessTtl: number; refreshTtl: number } {
  const env = validateEnv(process.env);
  return { accessTtl: env.jwtAccessTtlSec, refreshTtl: env.jwtRefreshTtlSec };
}

function secrets(): { access: string; refresh: string } {
  const env = validateEnv(process.env);
  return { access: env.jwtAccessSecret, refresh: env.jwtRefreshSecret };
}

function sessionCookiePolicy(): {
  sameSite: "lax" | "strict" | "none";
  secure: boolean;
} {
  const sameSite = validateEnv(process.env).authCookieSameSite;
  // SameSite=None is only honored together with Secure (cross-site). For
  // lax/strict keep the historical rule: secure only behind https
  // (production); plain http local dev would drop `Secure` cookies and break
  // the /login → /projects flow.
  const secure =
    sameSite === "none" ? true : process.env.NODE_ENV === "production";
  return { sameSite, secure };
}

function setSessionCookies(
  res: Response,
  refreshToken: string,
  refreshMaxAgeSec: number,
): void {
  const { sameSite, secure } = sessionCookiePolicy();
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite,
    secure,
    path: "/api/v1/auth",
    maxAge: refreshMaxAgeSec * 1000,
  });
  res.cookie(AUTH_MARKER_COOKIE, "1", {
    httpOnly: false,
    sameSite,
    secure,
    path: "/",
    maxAge: refreshMaxAgeSec * 1000,
  });
}

function clearSessionCookies(res: Response): void {
  // Clear with the same attributes the cookie was set with (name+path
  // identify it, sameSite/secure keep the deletion consistent).
  const { sameSite, secure } = sessionCookiePolicy();
  res.clearCookie(REFRESH_COOKIE, { sameSite, secure, path: "/api/v1/auth" });
  res.clearCookie(AUTH_MARKER_COOKIE, { sameSite, secure, path: "/" });
}

function readRefreshCookie(req: unknown): string | null {
  if (typeof req !== "object" || req === null) return null;
  const rec = req as { cookies?: unknown; headers?: Record<string, unknown> };
  const jar = rec.cookies as Record<string, unknown> | undefined;
  if (jar && typeof jar[REFRESH_COOKIE] === "string")
    return jar[REFRESH_COOKIE] as string;
  const raw = rec.headers?.["cookie"];
  if (typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === REFRESH_COOKIE) {
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      if (v) return v;
    }
  }
  return null;
}

/**
 * AuthController — internal accounts (email+password).
 *
 * - POST /api/v1/auth/register — 201 { user, tokens }, 409 `email_taken`.
 * - POST /api/v1/auth/login — 200 { user, tokens }, 401 `invalid_credentials`
 *   (generic — no user enumeration).
 * - POST /api/v1/auth/refresh — single-use rotation, 401 `invalid_credentials`.
 * - POST /api/v1/auth/logout — idempotent 200, revokes the refresh family member.
 * - GET/PATCH /api/v1/auth/me — Bearer-guarded profile (legacy mock
 *   fallback while AUTH_LEGACY_MOCK_FALLBACK is on).
 * Secrets never logged; error envelope stays { code, message, correlationId }.
 */
@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly local: LocalAuthProvider,
    private readonly logger: AppLogger = new AppLogger(AuthController.name),
  ) {}

  @Post("register")
  @ApiOperation({ summary: "Register a local account (email+password)" })
  @ApiResponse({ status: 201, type: AuthSessionDto })
  @ApiResponse({ status: 409, description: "email already registered" })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Res({ passthrough: true }) res: Response,
    @Req() req?: { correlationId?: string },
  ): Promise<AuthSessionDto> {
    const correlationId = req?.correlationId;
    const log = correlationId
      ? this.logger.withCorrelationId(correlationId)
      : this.logger;
    try {
      const created = await this.users.createLocal(body, correlationId);
      if (!created) {
        // No PII in logs — fixed event only (email never logged).
        log.warn(`[auth] register email_taken`);
        throw new ConflictException({
          code: "email_taken",
          message: "Email is already registered",
        });
      }
      const { access, refresh } = secrets();
      const { accessTtl, refreshTtl } = refreshTtlSec();
      const pair = await this.tokens.issuePair(
        { id: created.id, email: created.email },
        access,
        refresh,
        accessTtl,
        refreshTtl,
        correlationId,
      );
      setSessionCookies(res, pair.refreshToken, refreshTtl);
      log.info("[auth] register ok");
      return {
        user: toPublicUser(created) as AuthUserDto,
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        tokenType: "bearer",
        expiresIn: pair.expiresIn,
      };
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      // Strict Postgres: DB outages surface as 503 EXTERNAL_UNAVAILABLE
      // (Retry-After 30 via ApiErrorFilter) — never masked as 500.
      if (err instanceof ExternalServiceError) throw err;
      // Message + sanitized stack (AppLogger scrubs secrets); never tokens.
      log.error(
        `[auth] register failed: ${(err as Error)?.message ?? String(err)}`,
        (err as Error)?.stack,
      );
      throw new InternalServerErrorException({
        code: "internal_error",
        message: "Unexpected server error",
      });
    }
  }

  @Post("login")
  @HttpCode(200)
  @ApiOperation({ summary: "Log in with email+password" })
  @ApiResponse({ status: 200, type: AuthSessionDto })
  @ApiResponse({
    status: 401,
    description: "invalid credentials (generic, no enumeration)",
  })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
    @Req() req?: { correlationId?: string },
  ): Promise<AuthSessionDto> {
    const correlationId = req?.correlationId;
    const log = correlationId
      ? this.logger.withCorrelationId(correlationId)
      : this.logger;
    const user = await this.local.verify(
      body.email,
      body.password,
      correlationId,
    );
    if (!user) {
      // No PII in logs — fixed event only (email never logged).
      log.warn(`[auth] login invalid_credentials`);
      throw new UnauthorizedException({
        code: "invalid_credentials",
        message: "Invalid email or password",
      });
    }
    const { access, refresh } = secrets();
    const { accessTtl, refreshTtl } = refreshTtlSec();
    const pair = await this.tokens.issuePair(
      { id: user.id, email: user.email },
      access,
      refresh,
      accessTtl,
      refreshTtl,
      correlationId,
    );
    setSessionCookies(res, pair.refreshToken, refreshTtl);
    log.info("[auth] login ok");
    return {
      user: toPublicUser(user) as AuthUserDto,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: "bearer",
      expiresIn: pair.expiresIn,
    };
  }

  @Post("refresh")
  @HttpCode(200)
  @ApiOperation({ summary: "Rotate the refresh token (single-use)" })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({ status: 401, description: "invalid or reused refresh token" })
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput,
    @Res({ passthrough: true }) res: Response,
    @Req() req?: unknown,
  ): Promise<AuthTokensDto> {
    const presented = body.refreshToken || readRefreshCookie(req) || "";
    const correlationId =
      typeof req === "object" && req !== null
        ? (req as { correlationId?: string }).correlationId
        : undefined;
    const { access, refresh } = secrets();
    const { accessTtl, refreshTtl } = refreshTtlSec();
    const pair = await this.tokens.consumeRefresh(
      presented,
      refresh,
      (id) => this.users.emailForId(id, correlationId),
      access,
      accessTtl,
      refreshTtl,
      correlationId,
    );
    if (!pair) {
      throw new UnauthorizedException({
        code: "invalid_credentials",
        message: "Invalid email or password",
      });
    }
    setSessionCookies(res, pair.refreshToken, refreshTtl);
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: "bearer",
      expiresIn: pair.expiresIn,
    };
  }

  @Post("logout")
  @HttpCode(200)
  @ApiOperation({ summary: "Log out (revoke the refresh token, idempotent)" })
  @ApiResponse({ status: 200, description: "logged out" })
  async logout(
    @Body() body: Partial<RefreshInput>,
    @Res({ passthrough: true }) res: Response,
    @Req() req?: unknown,
  ): Promise<{ ok: boolean }> {
    const presented =
      (typeof body?.refreshToken === "string" ? body.refreshToken : "") ||
      readRefreshCookie(req) ||
      "";
    if (presented) {
      await this.tokens.revokeRefresh(presented, secrets().refresh);
    }
    clearSessionCookies(res);
    return { ok: true };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Current user profile" })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, type: AuthUserDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  async me(
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<AuthUserDto> {
    const user = await this.users.findById(identity.id, req?.correlationId);
    if (!user) {
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication required",
      });
    }
    return toPublicUser(user) as AuthUserDto;
  }

  @Patch("me")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Update current user profile (firstName/lastName)" })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, type: AuthUserDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  async updateMe(
    @ReqUser() identity: RequestIdentity,
    @Body(new ZodValidationPipe(updateMeSchema)) body: UpdateMeInput,
    @Req() req?: { correlationId?: string },
  ): Promise<AuthUserDto> {
    const user = await this.users.updateProfile(
      identity.id,
      body,
      req?.correlationId,
    );
    if (!user) {
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication required",
      });
    }
    return toPublicUser(user) as AuthUserDto;
  }
}

export type { LoginBodyDto, RefreshBodyDto, RegisterBodyDto, UpdateMeBodyDto };
