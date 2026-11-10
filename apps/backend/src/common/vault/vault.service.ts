import { Injectable } from '@nestjs/common';
import { AppLogger } from '../logger';
import { CryptoService, type EncryptedOpencodeKey } from '../crypto/crypto.service';
import { VaultRepository } from './vault.repository';
import type {
  VaultConsumer,
  VaultSecret,
  VaultSecretPatch,
} from './vault.types';

/** Plaintext input accepted by `create` (encrypted before it leaves memory). */
export type VaultCreateInput = {
  provider: string;
  label?: string;
  apiKey: string;
};

/** Plaintext/partial update accepted by `update` (apiKey is re-encrypted). */
export type VaultUpdateInput = {
  apiKey?: string;
  label?: string;
};

/** Ciphertext envelope accepted by `rewrap` (lazy KEK rotation). */
export type VaultRewrapInput = {
  encryptedKey: string;
  iv: string;
  keyId: string;
};

/** Resolves the owning uuid of a consumer (user id or organization id). */
function consumerIdOf(consumer: VaultConsumer): string {
  return consumer.kind === 'user' ? consumer.userId : consumer.organizationId;
}

/**
 * Upper bound for the in-memory rotation cursor map (~10k live consumers).
 * Prevents unbounded growth in long-lived processes; eviction is FIFO by
 * insertion order (Map preserves it), so the least recently *created*
 * cursor is dropped when a new consumer arrives at the cap.
 */
const MAX_ROTATION_CURSORS: number = 10_000;

/**
 * SCOPE: Common — reusable vault service, no organization/project knowledge.
 *
 * VaultService — encrypt/decrypt boundary around `VaultRepository`:
 * - `create`/`update` accept plaintext ONCE, encrypt with CryptoService
 *   (AES-256-GCM, versioned KEK) and persist ciphertext only.
 * - `get`/`list`/`remove`/`rewrap` never decrypt — consumers decrypt through
 *   CryptoService themselves, so plaintext never lives here.
 * - `pickNext` is the round-robin key selector: the list is ordered
 *   (`created_at ASC, id ASC`) and the per-process counter map advances one
 *   step per call. The rotation is PER PROCESS (right for a single instance;
 *   with several instances each keeps its own cursor — still balanced, never
 *   sticky). The cursor map is capped at `MAX_ROTATION_CURSORS` (FIFO
 *   eviction) so a long-lived process cannot grow it without bound.
 * - Nothing secret-bearing is ever logged (fixed event names only).
 */
@Injectable()
export class VaultService {
  /** Per-process round-robin cursors keyed `kind:consumerId:provider`. */
  private readonly rotation: Map<string, number> = new Map<string, number>();

  constructor(
    private readonly repository: VaultRepository,
    private readonly crypto: CryptoService,
    private readonly logger: AppLogger = new AppLogger(VaultService.name),
  ) {}

  /** Encrypts the plaintext key and inserts one secret for the consumer. */
  async create(
    consumer: VaultConsumer,
    input: VaultCreateInput,
    correlationId?: string,
  ): Promise<VaultSecret> {
    const envelope: EncryptedOpencodeKey = this.crypto.encrypt(
      input.apiKey.trim(),
    );
    const label: string = (input.label ?? '').trim();
    return this.repository.create(
      consumer,
      {
        provider: input.provider,
        label,
        encryptedKey: envelope.data,
        iv: envelope.iv,
        keyId: envelope.keyId,
      },
      correlationId,
    );
  }

  /**
   * Updates label and/or re-encrypts a new plaintext key (null when the id is
   * not the consumer's). An empty patch returns the current row unchanged.
   */
  async update(
    consumer: VaultConsumer,
    id: string,
    input: VaultUpdateInput,
    correlationId?: string,
  ): Promise<VaultSecret | null> {
    const patch: VaultSecretPatch = {};
    if (input.label !== undefined) {
      patch.label = input.label.trim();
    }
    if (input.apiKey !== undefined) {
      const envelope: EncryptedOpencodeKey = this.crypto.encrypt(
        input.apiKey.trim(),
      );
      patch.encryptedKey = envelope.data;
      patch.iv = envelope.iv;
      patch.keyId = envelope.keyId;
    }
    if (Object.keys(patch).length === 0) {
      return this.repository.findById(consumer, id, correlationId);
    }
    return this.repository.update(consumer, id, patch, correlationId);
  }

  /** Loads one consumer-owned secret (ciphertext only). */
  get(
    consumer: VaultConsumer,
    id: string,
    correlationId?: string,
  ): Promise<VaultSecret | null> {
    return this.repository.findById(consumer, id, correlationId);
  }

  /** Lists the consumer's secrets, optionally narrowed to one provider. */
  list(
    consumer: VaultConsumer,
    provider?: string,
    correlationId?: string,
  ): Promise<Array<VaultSecret>> {
    return this.repository.list(consumer, provider, correlationId);
  }

  /** Deletes one consumer-owned secret (idempotent). */
  remove(
    consumer: VaultConsumer,
    id: string,
    correlationId?: string,
  ): Promise<boolean> {
    return this.repository.deleteById(consumer, id, correlationId);
  }

  /** Lazy KEK rotation: replaces the ciphertext envelope of one row. */
  rewrap(
    consumer: VaultConsumer,
    id: string,
    envelope: VaultRewrapInput,
    correlationId?: string,
  ): Promise<VaultSecret | null> {
    return this.repository.update(consumer, id, envelope, correlationId);
  }

  /**
   * Round-robin pick among the consumer's secrets for one provider.
   *
   * Two keys → call 1 returns the first, call 2 the second, call 3 the first…
   * The cursor is in-memory and per process; a single instance cycles exactly.
   */
  async pickNext(
    consumer: VaultConsumer,
    provider: string,
    correlationId?: string,
  ): Promise<VaultSecret | null> {
    const secrets: Array<VaultSecret> = await this.repository.list(
      consumer,
      provider,
      correlationId,
    );
    if (secrets.length === 0) {
      return null;
    }
    const rotationKey: string = `${consumer.kind}:${consumerIdOf(consumer)}:${provider}`;
    if (!this.rotation.has(rotationKey) && this.rotation.size >= MAX_ROTATION_CURSORS) {
      const oldestKey: string | undefined = this.rotation.keys().next().value;
      if (oldestKey !== undefined) {
        this.rotation.delete(oldestKey);
      }
    }
    const cursor: number = this.rotation.get(rotationKey) ?? 0;
    const secret: VaultSecret = secrets[cursor % secrets.length];
    this.rotation.set(rotationKey, (cursor + 1) % secrets.length);
    this.logger.debug(`[vault] pick provider=${provider} index=${cursor}`);
    return secret;
  }
}
