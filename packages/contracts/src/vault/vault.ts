/**
 * Shared vault contracts — per-consumer (user/org) per-provider secret store.
 *
 * The vault is provider-agnostic: `provider` is an arbitrary lowercase id
 * (not only AI providers). Ciphertext never crosses the wire — only identity,
 * label and timestamps are exposed; the API key is write-only.
 */

/** One stored secret as exposed by the vault API (never carries the key). */
export type VaultSecretInfo = {
  id: string;
  provider: string;
  label: string;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 */
  updatedAt: string;
};

/** GET /vault/secrets — the caller's secret list. */
export type VaultSecretList = {
  secrets: Array<VaultSecretInfo>;
};

/** POST /vault/secrets — plaintext key is accepted once and encrypted at rest. */
export type VaultSecretInput = {
  provider: string;
  apiKey: string;
  label?: string;
};

/** PUT /vault/secrets/:id — at least one field must be present. */
export type VaultSecretUpdateInput = {
  apiKey?: string;
  label?: string;
};

/** DELETE /vault/secrets/:id result (idempotent). */
export type VaultSecretDeleteResult = {
  ok: boolean;
};
