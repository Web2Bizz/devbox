import { Injectable } from "@nestjs/common";
import { eq, ne } from "drizzle-orm";
import { AppLogger } from "../common/app-logger.service";
import { DbService, dbUnavailable, type DbClient } from "../db/db.service";
import { userOpencodeKeys, type UserOpencodeKeyRow } from "../db/schema";

/**
 * Stored per-user key row (ciphertext only — plaintext never persisted).
 * `keyId` names the wrapping KEK version ('' = legacy pre-versioning row).
 */
export type StoredOpencodeKey = {
  userId: string;
  encryptedKey: string;
  iv: string;
  keyId: string;
  /** ISO-8601 timestamp */
  updatedAt: string;
};

function toStored(row: UserOpencodeKeyRow): StoredOpencodeKey {
  return {
    userId: row.userId,
    encryptedKey: row.encryptedKey,
    iv: row.iv,
    keyId: row.keyId ?? "",
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * OpencodeKeysService — Postgres-backed per-user OpenCode API-key store
 * (strict, no memory fallback).
 *
 * Every method hits `user_opencode_keys` (drizzle/0005 + 0006); failures
 * funnel through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE (Retry-After 30
 * via ApiErrorFilter), logged once with the correlationId. Plaintext keys
 * never reach this service (callers encrypt via CryptoService first); nothing
 * secret-bearing is ever logged (fixed event names only).
 */
@Injectable()
export class OpencodeKeysService {
  constructor(
    private readonly logger: AppLogger = new AppLogger("OpencodeKeysService"),
    private readonly db: DbService,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /** Upserts the caller's encrypted key (insert or rotate on conflict). */
  async save(
    userId: string,
    input: { encryptedKey: string; iv: string; keyId: string },
    correlationId?: string,
  ): Promise<StoredOpencodeKey> {
    try {
      const rows = await this.client()
        .insert(userOpencodeKeys)
        .values({
          userId,
          encryptedKey: input.encryptedKey,
          iv: input.iv,
          keyId: input.keyId,
        })
        .onConflictDoUpdate({
          target: userOpencodeKeys.userId,
          set: {
            encryptedKey: input.encryptedKey,
            iv: input.iv,
            keyId: input.keyId,
            updatedAt: new Date(),
          },
        })
        .returning();
      this.logger.info("[opencode-keys] key saved");
      return toStored(rows[0]);
    } catch (err) {
      dbUnavailable("userOpencodeKeys.save", err, this.logger, correlationId);
    }
  }

  /** Loads the caller's row (null when no key was ever stored). */
  async findByUserId(
    userId: string,
    correlationId?: string,
  ): Promise<StoredOpencodeKey | null> {
    try {
      const rows = await this.client()
        .select()
        .from(userOpencodeKeys)
        .where(eq(userOpencodeKeys.userId, userId))
        .limit(1);
      return rows.length > 0 ? toStored(rows[0]) : null;
    } catch (err) {
      dbUnavailable("userOpencodeKeys.findByUserId", err, this.logger, correlationId);
    }
  }

  /**
   * User ids whose rows are not wrapped with the active KEK (rotation
   * backlog for the `keys:reencrypt` background pass; legacy '' rows count
   * as stale). Returns ids only — never ciphertext.
   */
  async findStaleUserIds(
    activeKeyId: string,
    limit = 500,
    correlationId?: string,
  ): Promise<string[]> {
    try {
      const rows = await this.client()
        .select({ userId: userOpencodeKeys.userId })
        .from(userOpencodeKeys)
        .where(ne(userOpencodeKeys.keyId, activeKeyId))
        .limit(limit);
      return rows.map((r) => r.userId);
    } catch (err) {
      dbUnavailable("userOpencodeKeys.findStaleUserIds", err, this.logger, correlationId);
    }
  }

  /** Deletes the caller's row (idempotent — missing row is still ok). */
  async deleteByUserId(userId: string, correlationId?: string): Promise<void> {
    try {
      await this.client()
        .delete(userOpencodeKeys)
        .where(eq(userOpencodeKeys.userId, userId));
      this.logger.info("[opencode-keys] key deleted");
    } catch (err) {
      dbUnavailable("userOpencodeKeys.deleteByUserId", err, this.logger, correlationId);
    }
  }
}
