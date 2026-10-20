import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { AppLogger } from "../common/app-logger.service";
import { DbService, dbUnavailable, type DbClient } from "../db/db.service";
import { users, type UserRow } from "../db/schema";
import { PasswordService } from "./password.service";

/** Auth provider ids — `local` is live; the rest are 501 stubs (no integration). */
export type AuthProviderId = "local" | "sso-oauth" | "github-app";

/** Stored user (durable contract = `users` drizzle table, drizzle/0003_users.sql). */
export type StoredUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  provider: AuthProviderId;
  createdAt: string;
  updatedAt: string;
};

/** Public shape — never carries passwordHash (never logged, never serialized). */
export function toPublicUser(u: StoredUser): {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  provider: AuthProviderId;
  createdAt: string;
} {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    provider: u.provider,
    createdAt: u.createdAt,
  };
}

function toStoredUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    passwordHash: row.passwordHash,
    provider: (row.provider as AuthProviderId) || "local",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * User ids are uuids (randomUUID at createLocal, uuid PK in Postgres).
 * A non-uuid key can never match a row — return null without querying so
 * mock identities (e.g. 'alice' via AUTH_LEGACY_MOCK_FALLBACK) keep the
 * designed null → 401/mock mapping on Postgres instead of a 22P02 500.
 */
function isUserId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/** Postgres unique-violation (email / users_email_lower_idx) → caller answers 409. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // node-postgres surfaces `code` directly; drizzle-orm wraps it as `cause`.
  const code = (err as { code?: unknown }).code;
  const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
  return code === "23505" || causeCode === "23505";
}

/**
 * UsersService — Postgres-backed user registry (strict, no memory fallback).
 *
 * Every method hits the `users` table (drizzle/0003_users.sql); data
 * survives restarts. When Postgres is unconfigured/unreachable the drizzle
 * throw funnels through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE
 * (Retry-After 30 via ApiErrorFilter), logged once with the correlationId.
 * Lookup key is the lowercased email (mirrors users_email_lower_idx).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly passwords: PasswordService,
    private readonly logger: AppLogger = new AppLogger("UsersService"),
    private readonly db: DbService,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /** Creates a local user; null when the email is taken (caller answers 409). */
  async createLocal(
    input: {
      firstName: string;
      lastName: string;
      email: string;
      password: string;
    },
    correlationId?: string,
  ): Promise<StoredUser | null> {
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    const email = input.email.trim();
    const passwordHash = await this.passwords.hash(input.password);
    try {
      const rows = await this.client()
        .insert(users)
        .values({ firstName, lastName, email, passwordHash, provider: "local" })
        .returning();
      this.logger.info("[auth] user registered");
      return toStoredUser(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // No PII in logs — fixed event only (email never logged).
        this.logger.warn(`[auth] createLocal duplicate`, correlationId);
        return null;
      }
      dbUnavailable("users.createLocal", err, this.logger, correlationId);
    }
  }

  async findByEmail(
    email: string,
    correlationId?: string,
  ): Promise<StoredUser | null> {
    try {
      const rows = await this.client()
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = lower(${email})`)
        .limit(1);
      return rows.length > 0 ? toStoredUser(rows[0]) : null;
    } catch (err) {
      dbUnavailable("users.findByEmail", err, this.logger, correlationId);
    }
  }

  async findById(
    id: string,
    correlationId?: string,
  ): Promise<StoredUser | null> {
    if (!isUserId(id)) return null;
    try {
      const rows = await this.client()
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return rows.length > 0 ? toStoredUser(rows[0]) : null;
    } catch (err) {
      dbUnavailable("users.findById", err, this.logger, correlationId);
    }
  }

  async emailForId(id: string, correlationId?: string): Promise<string | null> {
    return (await this.findById(id, correlationId))?.email ?? null;
  }

  async updateProfile(
    id: string,
    patch: { firstName?: string; lastName?: string },
    correlationId?: string,
  ): Promise<StoredUser | null> {
    if (!isUserId(id)) return null;
    const firstName = patch.firstName?.trim()
      ? patch.firstName.trim()
      : undefined;
    const lastName = patch.lastName?.trim() ? patch.lastName.trim() : undefined;
    try {
      const rows = await this.client()
        .update(users)
        .set({
          ...(firstName !== undefined ? { firstName } : {}),
          ...(lastName !== undefined ? { lastName } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning();
      return rows.length > 0 ? toStoredUser(rows[0]) : null;
    } catch (err) {
      dbUnavailable("users.updateProfile", err, this.logger, correlationId);
    }
  }

  /** Test/e2e seam — DELETE FROM users (requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    await this.client().delete(users);
  }
}
