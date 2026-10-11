import { Injectable, UnauthorizedException } from "@nestjs/common";
import { AppLogger } from "../common/app-logger.service.js";
import { PasswordService } from "./password.service.js";
import { UsersService, type StoredUser } from "./users.service.js";
import type { AuthProviderId } from "./users.service.js";

/** Strategy seam for external identity providers (local + future stubs). */
export interface AuthProvider {
  readonly id: AuthProviderId;
  /** Returns the user on success, null on bad credentials (caller answers 401/409). */
  verify(
    email: string,
    password: string,
    correlationId?: string,
  ): Promise<StoredUser | null>;
}

export type { AuthProviderId };

/** Live local provider — email + argon2id password (Bun.password). */
@Injectable()
export class LocalAuthProvider implements AuthProvider {
  readonly id: AuthProviderId = "local";

  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly logger: AppLogger = new AppLogger("LocalAuthProvider"),
  ) {}

  async verify(
    email: string,
    password: string,
    correlationId?: string,
  ): Promise<StoredUser | null> {
    const user = await this.users.findByEmail(email, correlationId);
    // Same code path for unknown emails (timing-neutral, no enumeration).
    const hash = user?.passwordHash ?? "";
    const ok =
      hash !== "" &&
      (await this.passwords.verify(password, hash, correlationId));
    if (!ok || !user) {
      this.logger.warn("[auth] local verify failed", correlationId);
      return null;
    }
    return user;
  }
}

/**
 * SSO/OAuth provider stub — seam only (no integration, no network).
 * Any call answers 501 `provider_not_configured` via the controller guard.
 */
@Injectable()
export class SsoOauthProviderStub implements AuthProvider {
  readonly id: AuthProviderId = "sso-oauth";

  verify(): Promise<StoredUser | null> {
    throw new UnauthorizedException({
      code: "provider_not_configured",
      message: "SSO/OAuth provider is not configured",
    });
  }
}

/**
 * GitHub-App identity stub — seam only (the GitHub App surface in
 * projects/github stays token-based and untouched; this stub reserves the
 * future "log in with GitHub" provider slot).
 */
@Injectable()
export class GithubAppProviderStub implements AuthProvider {
  readonly id: AuthProviderId = "github-app";

  verify(): Promise<StoredUser | null> {
    throw new UnauthorizedException({
      code: "provider_not_configured",
      message: "GitHub App identity provider is not configured",
    });
  }
}
