import { Injectable } from "@nestjs/common";
import { AppLogger } from "../common/logger";
import { dbUnavailable } from "../common/db/db.service";
import { hashPassword } from "./utils/password";
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
 * Business logic only: trimming, hashing (stateless `utils/password` util) and
 * error mapping. Every drizzle query lives in UsersRepository, so this service
 * never imports `drizzle-orm` or the schema. When Postgres is
 * unconfigured/unreachable the repository throws and `dbUnavailable` funnels it
 * to 503 EXTERNAL_UNAVAILABLE (Retry-After 30 via ApiErrorFilter), logged once
 * with the correlationId.
 * Lookup key is the lowercased email: rows are stored lowercased, so the
 * `users_email_unique` constraint makes registration case-insensitive and
 * `findByEmail` (`lower(email) = lower($1)`) reads legacy mixed-case rows.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly logger: AppLogger = new AppLogger(UsersService.name),
  ) {}

  /** Creates a local user; null when the email is taken (caller answers 409). */
  async createLocal(
    input: CreateLocalInput,
    correlationId?: string,
  ): Promise<StoredUser | null> {
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password, this.logger);
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

  /** Compensating rollback for register when personal-org creation fails. */
  async deleteById(
    id: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.usersRepository.deleteById(id);
    } catch (error) {
      dbUnavailable("users.deleteById", error, this.logger, correlationId);
    }
  }

  /** Test/e2e seam — DELETE FROM users (requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    await this.usersRepository.deleteAll();
  }
}
