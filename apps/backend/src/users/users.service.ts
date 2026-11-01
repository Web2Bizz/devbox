import { Injectable } from "@nestjs/common";
import { AppLogger } from "../common/logger";
import { dbUnavailable } from "../common/db/db.service";
import { PasswordService } from "./modules/password/password.service";
import type {
  CreateLocalInput,
  PublicUser,
  StoredUser,
  UpdateProfilePatch,
} from "./users.types";
import { UsersRepository } from "./users.repository";

/** Public shape — never carries passwordHash (never logged, never serialized). */
export function toPublicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    provider: user.provider,
    createdAt: user.createdAt,
  };
}

/**
 * UsersService — Postgres-backed user registry (strict, no memory fallback).
 *
 * Business logic only: trimming, hashing and error mapping. Every drizzle query
 * lives in UsersRepository, so this service never imports `drizzle-orm` or the
 * schema. When Postgres is unconfigured/unreachable the repository throws and
 * `dbUnavailable` funnels it to 503 EXTERNAL_UNAVAILABLE (Retry-After 30 via
 * ApiErrorFilter), logged once with the correlationId.
 * Lookup key is the lowercased email (mirrors users_email_lower_idx).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly passwordService: PasswordService,
    private readonly usersRepository: UsersRepository,
    private readonly logger: AppLogger = new AppLogger("UsersService"),
  ) {}

  /** Creates a local user; null when the email is taken (caller answers 409). */
  async createLocal(
    input: CreateLocalInput,
    correlationId?: string,
  ): Promise<StoredUser | null> {
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    const email = input.email.trim();
    const passwordHash = await this.passwordService.hash(input.password);
    try {
      const user = await this.usersRepository.insertLocal({
        firstName,
        lastName,
        email,
        passwordHash,
      });
      if (!user) {
        // No PII in logs — fixed event only (email never logged).
        this.logger.warn(`[auth] createLocal duplicate`, correlationId);
        return null;
      }
      this.logger.info("[auth] user registered");
      return user;
    } catch (error) {
      dbUnavailable("users.createLocal", error, this.logger, correlationId);
    }
  }

  async findByEmail(
    email: string,
    correlationId?: string,
  ): Promise<StoredUser | null> {
    try {
      return await this.usersRepository.findByEmail(email);
    } catch (error) {
      dbUnavailable("users.findByEmail", error, this.logger, correlationId);
    }
  }

  async findById(
    id: string,
    correlationId?: string,
  ): Promise<StoredUser | null> {
    try {
      return await this.usersRepository.findById(id);
    } catch (error) {
      dbUnavailable("users.findById", error, this.logger, correlationId);
    }
  }

  async emailForId(id: string, correlationId?: string): Promise<string | null> {
    return (await this.findById(id, correlationId))?.email ?? null;
  }

  async updateProfile(
    id: string,
    patch: UpdateProfilePatch,
    correlationId?: string,
  ): Promise<StoredUser | null> {
    const firstName = patch.firstName?.trim()
      ? patch.firstName.trim()
      : undefined;
    const lastName = patch.lastName?.trim() ? patch.lastName.trim() : undefined;
    try {
      return await this.usersRepository.updateProfile(id, {
        firstName,
        lastName,
      });
    } catch (error) {
      dbUnavailable("users.updateProfile", error, this.logger, correlationId);
    }
  }

  /** Test/e2e seam — DELETE FROM users (requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    await this.usersRepository.deleteAll();
  }
}
