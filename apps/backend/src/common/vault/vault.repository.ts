import { Injectable } from '@nestjs/common';
import { and, asc, eq, ne, type SQL } from 'drizzle-orm';
import { AppLogger } from '../logger';
import { DbService, dbUnavailable, type DbClient } from '../db/db.service';
import { vaultSecrets, type VaultSecretRow } from '../db/schema';
import type {
  StaleVaultSecret,
  VaultConsumer,
  VaultConsumerKind,
  VaultSecret,
  VaultSecretPatch,
  VaultSecretWrite,
} from './vault.types';

/** Resolves the owning uuid of a consumer (user id or organization id). */
function consumerIdOf(consumer: VaultConsumer): string {
  return consumer.kind === 'user' ? consumer.userId : consumer.organizationId;
}

/** Row → domain secret (timestamps normalized to ISO-8601). */
function toVaultSecret(row: VaultSecretRow): VaultSecret {
  const consumerKind: VaultConsumerKind =
    row.consumerType === 'org' ? 'org' : 'user';
  return {
    id: row.id,
    consumerKind,
    consumerId: row.consumerId,
    provider: row.provider,
    label: row.label,
    encryptedKey: row.encryptedKey,
    iv: row.iv,
    keyId: row.keyId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `(consumer_type, consumer_id)` scope — every consumer-facing query uses it. */
function consumerScope(consumer: VaultConsumer): SQL {
  const condition: SQL | undefined = and(
    eq(vaultSecrets.consumerType, consumer.kind),
    eq(vaultSecrets.consumerId, consumerIdOf(consumer)),
  );
  if (!condition) {
    throw new Error('vault: empty consumer scope');
  }
  return condition;
}

/**
 * SCOPE: Common — reusable vault store, no organization/project knowledge.
 *
 * VaultRepository — Postgres-backed secret store (strict, no memory
 * fallback). Every consumer-facing query is scoped by `(consumer_type,
 * consumer_id)`; the rotation helpers (`updateById`, `findStale`) are the only
 * unscoped paths and never leave ciphertext. Failures funnel through
 * `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE (Retry-After 30 via
 * ApiErrorFilter), logged once with the correlationId. Plaintext never
 * reaches this layer.
 */
@Injectable()
export class VaultRepository {
  constructor(
    private readonly db: DbService,
    private readonly logger: AppLogger = new AppLogger(VaultRepository.name),
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /** Inserts one encrypted secret for the consumer. */
  async create(
    consumer: VaultConsumer,
    write: VaultSecretWrite,
    correlationId?: string,
  ): Promise<VaultSecret> {
    try {
      const rows: Array<VaultSecretRow> = await this.client()
        .insert(vaultSecrets)
        .values({
          consumerType: consumer.kind,
          consumerId: consumerIdOf(consumer),
          provider: write.provider,
          label: write.label,
          encryptedKey: write.encryptedKey,
          iv: write.iv,
          keyId: write.keyId,
        })
        .returning();
      this.logger.info('[vault] secret created');
      return toVaultSecret(rows[0]);
    } catch (error) {
      dbUnavailable('vaultSecrets.create', error, this.logger, correlationId);
    }
  }

  /** Updates one consumer-owned secret (null when the id is not theirs). */
  async update(
    consumer: VaultConsumer,
    id: string,
    patch: VaultSecretPatch,
    correlationId?: string,
  ): Promise<VaultSecret | null> {
    try {
      const rows: Array<VaultSecretRow> = await this.client()
        .update(vaultSecrets)
        .set({
          ...patch,
          updatedAt: new Date(),
        })
        .where(and(eq(vaultSecrets.id, id), consumerScope(consumer)))
        .returning();
      return rows.length > 0 ? toVaultSecret(rows[0]) : null;
    } catch (error) {
      dbUnavailable('vaultSecrets.update', error, this.logger, correlationId);
    }
  }

  /** Loads one consumer-owned secret by id (null when absent/foreign). */
  async findById(
    consumer: VaultConsumer,
    id: string,
    correlationId?: string,
  ): Promise<VaultSecret | null> {
    try {
      const rows: Array<VaultSecretRow> = await this.client()
        .select()
        .from(vaultSecrets)
        .where(and(eq(vaultSecrets.id, id), consumerScope(consumer)))
        .limit(1);
      return rows.length > 0 ? toVaultSecret(rows[0]) : null;
    } catch (error) {
      dbUnavailable(
        'vaultSecrets.findById',
        error,
        this.logger,
        correlationId,
      );
    }
  }

  /**
   * Lists the consumer's secrets (optionally narrowed to one provider),
   * ordered `created_at ASC, id ASC` — the deterministic order round-robin
   * selection depends on.
   */
  async list(
    consumer: VaultConsumer,
    provider: string | undefined,
    correlationId?: string,
  ): Promise<Array<VaultSecret>> {
    try {
      const condition: SQL | undefined = and(
        consumerScope(consumer),
        provider !== undefined ? eq(vaultSecrets.provider, provider) : undefined,
      );
      const rows: Array<VaultSecretRow> = await this.client()
        .select()
        .from(vaultSecrets)
        .where(condition)
        .orderBy(asc(vaultSecrets.createdAt), asc(vaultSecrets.id));
      return rows.map((row: VaultSecretRow): VaultSecret => toVaultSecret(row));
    } catch (error) {
      dbUnavailable('vaultSecrets.list', error, this.logger, correlationId);
    }
  }

  /** Deletes one consumer-owned secret (false when absent/foreign). */
  async deleteById(
    consumer: VaultConsumer,
    id: string,
    correlationId?: string,
  ): Promise<boolean> {
    try {
      const rows: Array<{ id: string }> = await this.client()
        .delete(vaultSecrets)
        .where(and(eq(vaultSecrets.id, id), consumerScope(consumer)))
        .returning({ id: vaultSecrets.id });
      if (rows.length > 0) {
        this.logger.info('[vault] secret deleted');
      }
      return rows.length > 0;
    } catch (error) {
      dbUnavailable(
        'vaultSecrets.deleteById',
        error,
        this.logger,
        correlationId,
      );
    }
  }

  /**
   * KEK-rotation path: updates one row by id without a consumer scope (the
   * background pass has no caller identity). Ciphertext in, ciphertext out.
   */
  async updateById(
    id: string,
    patch: VaultSecretPatch,
    correlationId?: string,
  ): Promise<VaultSecret | null> {
    try {
      const rows: Array<VaultSecretRow> = await this.client()
        .update(vaultSecrets)
        .set({
          ...patch,
          updatedAt: new Date(),
        })
        .where(eq(vaultSecrets.id, id))
        .returning();
      return rows.length > 0 ? toVaultSecret(rows[0]) : null;
    } catch (error) {
      dbUnavailable(
        'vaultSecrets.updateById',
        error,
        this.logger,
        correlationId,
      );
    }
  }

  /**
   * Rows whose `key_id` is not the active KEK (rotation backlog). Identity
   * only — never ciphertext.
   */
  async findStale(
    activeKeyId: string,
    limit: number,
    correlationId?: string,
  ): Promise<Array<StaleVaultSecret>> {
    try {
      const rows: Array<{
        id: string;
        consumerType: string;
        consumerId: string;
        provider: string;
      }> = await this.client()
        .select({
          id: vaultSecrets.id,
          consumerType: vaultSecrets.consumerType,
          consumerId: vaultSecrets.consumerId,
          provider: vaultSecrets.provider,
        })
        .from(vaultSecrets)
        .where(ne(vaultSecrets.keyId, activeKeyId))
        .limit(limit);
      return rows.map((row: {
        id: string;
        consumerType: string;
        consumerId: string;
        provider: string;
      }): StaleVaultSecret => {
        const consumerKind: VaultConsumerKind =
          row.consumerType === 'org' ? 'org' : 'user';
        return {
          id: row.id,
          consumerKind,
          consumerId: row.consumerId,
          provider: row.provider,
        };
      });
    } catch (error) {
      dbUnavailable(
        'vaultSecrets.findStale',
        error,
        this.logger,
        correlationId,
      );
    }
  }
}
