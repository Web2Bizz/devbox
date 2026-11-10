import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DbService, type DbClient } from "@common/db/db.service";
import { users, vaultSecrets, type UserRow } from "@common/db/schema";
import { uuidSchema } from "@common/validation";
import type { AuthProviderId, StoredUser } from "./users.types";

/** Drizzle row → domain shape (Date → ISO-8601 at the DB boundary, CoC §2). */
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

/** Postgres unique-violation (email) → caller answers 409. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // node-postgres surfaces `code` directly; drizzle-orm wraps it as `cause`.
  const code: unknown = (error as { code?: unknown }).code;
  const causeCode: unknown = (error as { cause?: { code?: unknown } }).cause?.code;
  return code === "23505" || causeCode === "23505";
}

/**
 * UsersRepository — the only place in the users domain that touches drizzle.
 * UsersService never imports `drizzle-orm` or `common/db/schema`; infrastructure
 * failures bubble up as raw errors and are mapped to 503 EXTERNAL_UNAVAILABLE
 * by the service (`dbUnavailable`). The 409 detection (SQLSTATE 23505) and the
 * uuid guard stay private here (decision recorded in the plan, § Решения).
 *
 * User ids are uuids (randomUUID at createLocal, uuid PK in Postgres); a
 * non-uuid key can never match a row, so callers return null without querying
 * — mock identities (e.g. 'alice' via AUTH_LEGACY_MOCK_FALLBACK) keep the
 * designed null → 401/mock mapping on Postgres instead of a 22P02 500.
 */
@Injectable()
export class UsersRepository {
  constructor(private readonly databaseService: DbService) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.databaseService.client;
  }

  /** Inserts a local user; null when the email is taken (caller answers 409). */
  async insertLocal(user: {
    firstName: string;
    lastName: string;
    email: string;
    passwordHash: string;
  }): Promise<StoredUser | null> {
    try {
      const rows: Array<UserRow> = await this.client()
        .insert(users)
        .values({
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          passwordHash: user.passwordHash,
          provider: "local",
        })
        .returning();
      return toStoredUser(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async findByEmail(email: string): Promise<StoredUser | null> {
    const rows: Array<UserRow> = await this.client()
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);
    return rows.length > 0 ? toStoredUser(rows[0]) : null;
  }

  async findById(id: string): Promise<StoredUser | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const rows: Array<UserRow> = await this.client()
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return rows.length > 0 ? toStoredUser(rows[0]) : null;
  }

  async updateProfile(
    id: string,
    patch: { firstName?: string; lastName?: string },
  ): Promise<StoredUser | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const rows: Array<UserRow> = await this.client()
      .update(users)
      .set({
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    return rows.length > 0 ? toStoredUser(rows[0]) : null;
  }

  /** Test/e2e seam — DELETE FROM users (requires live Postgres). */
  async deleteAll(): Promise<void> {
    await this.client().transaction(async (transaction) => {
      // Vault rows have no FK on the polymorphic consumer_id — clear them
      // explicitly before the users they belong to disappear.
      await transaction.delete(vaultSecrets);
      await transaction.delete(users);
    });
  }

  /**
   * Compensating rollback for register: remove a just-created user together
   * with their vault secrets (no FK on the polymorphic consumer_id, so the
   * cleanup is compensated here in the same transaction).
   */
  async deleteById(id: string): Promise<void> {
    await this.client().transaction(async (transaction) => {
      await transaction
        .delete(vaultSecrets)
        .where(
          and(
            eq(vaultSecrets.consumerType, "user"),
            eq(vaultSecrets.consumerId, id),
          ),
        );
      await transaction.delete(users).where(eq(users.id, id));
    });
  }
}
