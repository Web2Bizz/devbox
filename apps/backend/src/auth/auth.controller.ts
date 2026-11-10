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
import { AppLogger } from "@common/logger";
import { ExternalServiceError } from "@common/external/external-error";
import { ZodValidationPipe } from "@common/validation";
import { validateEnv, type AppEnv } from "@common/env/env";
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
  logoutSchema,
  refreshSchema,
  registerSchema,
  updateMeSchema,
  type LoginInput,
  type LogoutInput,
  type RefreshInput,
  type RegisterInput,
  type UpdateMeInput,
} from "./auth.dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { ReqUser } from "./req-user.decorator";
import type { RequestIdentity } from "./identity.service";
import { TokenService, type TokenPair } from "./token.service";
import { UsersService, toPublicUser } from "@users/users.service";
import type { StoredUser } from "@users/users.types";
import { OrganizationsService } from "../organizations/organizations.service";

/** Logger bound to one correlation id (the shape `withCorrelationId` returns). */
type ScopedLogger = ReturnType<AppLogger["withCorrelationId"]>;

/** httpOnly refresh cookie (read by POST /auth/refresh via body or cookie). */
export const REFRESH_COOKIE: string = "rush-code-refresh";
/** Readable marker for the Next middleware guard (carries no secret). */
export const AUTH_MARKER_COOKIE: string = "rush-code-auth";

function refreshTtlSec(): { accessTtl: number; refreshTtl: number } {
  const env: AppEnv = validateEnv(process.env);
  return { accessTtl: env.jwtAccessTtlSec, refreshTtl: env.jwtRefreshTtlSec };
}

function secrets(): { access: string; refresh: string } {
  const env: AppEnv = validateEnv(process.env);
  return { access: env.jwtAccessSecret, refresh: env.jwtRefreshSecret };
}

function sessionCookiePolicy(): {
  sameSite: "lax" | "strict" | "none";
  secure: boolean;
} {
  const sameSite: "lax" | "strict" | "none" = validateEnv(process.env).authCookieSameSite;
  // SameSite=None is only honored together with Secure (cross-site). For
  // lax/strict keep the historical rule: secure only behind https
  // (production); plain http local dev would drop `Secure` cookies and break
  // the /login → /projects flow.
  const secure: boolean =
    sameSite === "none" ? true : process.env.NODE_ENV === "production";
  return { sameSite, secure };
}

function setSessionCookies(
  response: Response,
  refreshToken: string,
  refreshMaxAgeSec: number,
): void {
  const { sameSite, secure } = sessionCookiePolicy();
  response.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite,
    secure,
    path: "/api/v1/auth",
    maxAge: refreshMaxAgeSec * 1000,
  });
  response.cookie(AUTH_MARKER_COOKIE, "1", {
    httpOnly: false,
    sameSite,
    secure,
    path: "/",
    maxAge: refreshMaxAgeSec * 1000,
  });
}

function clearSessionCookies(response: Response): void {
  // Clear with the same attributes the cookie was set with (name+path
  // identify it, sameSite/secure keep the deletion consistent).
  const { sameSite, secure } = sessionCookiePolicy();
  response.clearCookie(REFRESH_COOKIE, { sameSite, secure, path: "/api/v1/auth" });
  response.clearCookie(AUTH_MARKER_COOKIE, { sameSite, secure, path: "/" });
}

function readRefreshCookie(request: unknown): string | null {
  if (typeof request !== "object" || request === null) return null;
  const record: { cookies?: unknown; headers?: Record<string, unknown> } = request as {
    cookies?: unknown;
    headers?: Record<string, unknown>;
  };
  const cookieJar: Record<string, unknown> | undefined = record.cookies as
    | Record<string, unknown>
    | undefined;
  if (cookieJar && typeof cookieJar[REFRESH_COOKIE] === "string")
    return cookieJar[REFRESH_COOKIE] as string;
  const rawCookieHeader: unknown = record.headers?.["cookie"];
  if (typeof rawCookieHeader !== "string") return null;
  for (const part of rawCookieHeader.split(";")) {
    const index: number = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === REFRESH_COOKIE) {
      const value: string = decodeURIComponent(part.slice(index + 1).trim());
      if (value) return value;
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
    private readonly organizations: OrganizationsService,
    private readonly logger: AppLogger = new AppLogger(AuthController.name),
  ) {}

  @Post("register")
  @ApiOperation({ summary: "Register a local account (email+password)" })
  @ApiResponse({ status: 201, type: AuthSessionDto })
  @ApiResponse({ status: 409, description: "email already registered" })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Res({ passthrough: true }) response: Response,
    @Req() request?: { correlationId?: string },
  ): Promise<AuthSessionDto> {
    const correlationId: string | undefined = request?.correlationId;
    const logger: ScopedLogger = correlationId
      ? this.logger.withCorrelationId(correlationId)
      : this.logger;
    try {
      const createdUser: StoredUser | null = await this.users.createLocal(body, correlationId);
      if (!createdUser) {
        // No PII in logs — fixed event only (email never logged).
        logger.warn(`[auth] register email_taken`);
        throw new ConflictException({
          code: "email_taken",
          message: "Email is already registered",
        });
      }
      // Every user owns exactly one personal org (org-only model): it is
      // created right after the user row via OrganizationsService.create
      // with isPersonal=true (owner + maintainer = the new user). An org
      // failure must not leave a user without an org — compensate by
      // removing the just-created user, then propagate (500 for disk,
      // 503 for DB outages via the services' dbUnavailable mapping).
      try {
        await this.organizations.create(
          { name: `${createdUser.email} personal`, isPersonal: true },
          createdUser.id,
          correlationId,
        );
      } catch (organizationError) {
        try {
          await this.users.deleteById(createdUser.id, correlationId);
        } catch {
          // Compensating delete is best-effort — the original org error
          // below stays the caller's outcome (never masked).
        }
        throw organizationError;
      }
      const { access, refresh } = secrets();
      const { accessTtl, refreshTtl } = refreshTtlSec();
      const tokenPair: TokenPair = await this.tokens.issuePair(
        { id: createdUser.id, email: createdUser.email },
        access,
        refresh,
        accessTtl,
        refreshTtl,
        correlationId,
      );
      setSessionCookies(response, tokenPair.refreshToken, refreshTtl);
      logger.info("[auth] register ok");
      return {
        user: toPublicUser(createdUser) as AuthUserDto,
        accessToken: tokenPair.accessToken,
        refreshToken: tokenPair.refreshToken,
        tokenType: "bearer",
        expiresIn: tokenPair.expiresIn,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      // Strict Postgres: DB outages surface as 503 EXTERNAL_UNAVAILABLE
      // (Retry-After 30 via ApiErrorFilter) — never masked as 500.
      if (error instanceof ExternalServiceError) throw error;
      // Message + sanitized stack (AppLogger scrubs secrets); never tokens.
      logger.error(
        `[auth] register failed: ${(error as Error)?.message ?? String(error)}`,
        (error as Error)?.stack,
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
    @Res({ passthrough: true }) response: Response,
    @Req() request?: { correlationId?: string },
  ): Promise<AuthSessionDto> {
    const correlationId: string | undefined = request?.correlationId;
    const logger: ScopedLogger = correlationId
      ? this.logger.withCorrelationId(correlationId)
      : this.logger;
    const user: StoredUser | null = await this.local.verify(
      body.email,
      body.password,
      correlationId,
    );
    if (!user) {
      // No PII in logs — fixed event only (email never logged).
      logger.warn(`[auth] login invalid_credentials`);
      throw new UnauthorizedException({
        code: "invalid_credentials",
        message: "Invalid email or password",
      });
    }
    const { access, refresh } = secrets();
    const { accessTtl, refreshTtl } = refreshTtlSec();
    const tokenPair: TokenPair = await this.tokens.issuePair(
        { id: user.id, email: user.email },
        access,
        refresh,
        accessTtl,
        refreshTtl,
        correlationId,
      );
    setSessionCookies(response, tokenPair.refreshToken, refreshTtl);
    logger.info("[auth] login ok");
    return {
      user: toPublicUser(user) as AuthUserDto,
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      tokenType: "bearer",
      expiresIn: tokenPair.expiresIn,
    };
  }

  @Post("refresh")
  @HttpCode(200)
  @ApiOperation({ summary: "Rotate the refresh token (single-use)" })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({ status: 401, description: "invalid or reused refresh token" })
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput,
    @Res({ passthrough: true }) response: Response,
    @Req() request?: unknown,
  ): Promise<AuthTokensDto> {
    const presentedToken: string =
      body.refreshToken || readRefreshCookie(request) || "";
    const correlationId: string | undefined =
      typeof request === "object" && request !== null
        ? (request as { correlationId?: string }).correlationId
        : undefined;
    const { access, refresh } = secrets();
    const { accessTtl, refreshTtl } = refreshTtlSec();
    const tokenPair: TokenPair | null = await this.tokens.consumeRefresh(
        presentedToken,
        refresh,
        (userId: string) => this.users.emailForId(userId, correlationId),
        access,
        accessTtl,
        refreshTtl,
        correlationId,
      );
    if (!tokenPair) {
      throw new UnauthorizedException({
        code: "invalid_credentials",
        message: "Invalid email or password",
      });
    }
    setSessionCookies(response, tokenPair.refreshToken, refreshTtl);
    return {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      tokenType: "bearer",
      expiresIn: tokenPair.expiresIn,
    };
  }

  @Post("logout")
  @HttpCode(200)
  @ApiOperation({ summary: "Log out (revoke the refresh token, idempotent)" })
  @ApiResponse({ status: 200, description: "logged out" })
  async logout(
    @Body(new ZodValidationPipe(logoutSchema)) body: LogoutInput,
    @Res({ passthrough: true }) response: Response,
    @Req() request?: unknown,
  ): Promise<{ ok: boolean }> {
    const presentedToken: string =
      (typeof body?.refreshToken === "string" ? body.refreshToken : "") ||
      readRefreshCookie(request) ||
      "";
    if (presentedToken) {
      await this.tokens.revokeRefresh(presentedToken, secrets().refresh);
    }
    clearSessionCookies(response);
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
    @Req() request?: { correlationId?: string },
  ): Promise<AuthUserDto> {
    const user: StoredUser | null = await this.users.findById(
      identity.id,
      request?.correlationId,
    );
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
    @Req() request?: { correlationId?: string },
  ): Promise<AuthUserDto> {
    const user: StoredUser | null = await this.users.updateProfile(
      identity.id,
      body,
      request?.correlationId,
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
