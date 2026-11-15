/**
 * SCOPE: Common — reusable vault types, no organization/project knowledge.
 *
 * Vault types are provider-agnostic: a consumer is a user or an org, a provider
 * is an arbitrary lowercase id, and the stored value is always ciphertext.
 */

/** Who owns a vault secret. */
export type VaultConsumerKind = 'user' | 'org';

/** Caller identity a secret belongs to (polymorphic consumer). */
export type VaultConsumer =
  | { kind: 'user'; userId: string }
  | { kind: 'org'; organizationId: string };

/** Stored secret (ciphertext only — plaintext never persisted). */
export type VaultSecret = {
  id: string;
  consumerKind: VaultConsumerKind;
  consumerId: string;
  provider: string;
  label: string;
  encryptedKey: string;
  iv: string;
  keyId: string;
  /** ISO-8601 timestamp */
  createdAt: string;
  /** ISO-8601 timestamp */
  updatedAt: string;
};

/** Encrypted material accepted by the repository on insert. */
export type VaultSecretWrite = {
  provider: string;
  label: string;
  encryptedKey: string;
  iv: string;
  keyId: string;
};

/** Partial update — label and/or ciphertext envelope (never plaintext). */
export type VaultSecretPatch = {
  label?: string;
  encryptedKey?: string;
  iv?: string;
  keyId?: string;
};

/** Identity of a stale row (rotation backlog) — never carries ciphertext. */
export type StaleVaultSecret = {
  id: string;
  consumerKind: VaultConsumerKind;
  consumerId: string;
  provider: string;
};
