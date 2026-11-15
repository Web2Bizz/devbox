/**
 * SCOPE: Common — provider ids the vault recognizes.
 *
 * The vault itself stores ANY provider id (`vaultProviderSchema` accepts
 * arbitrary lowercase ids); this list only names the providers the current
 * consumers know about, so callers stop hard-coding string literals.
 */

export const OPENCODE_PROVIDER: string = 'opencode';

export const OPENROUTER_PROVIDER: string = 'openrouter';

/** Providers shipped in-code today (not a closed allowlist for storage). */
export const KNOWN_VAULT_PROVIDERS: ReadonlyArray<string> = [
  OPENCODE_PROVIDER,
  OPENROUTER_PROVIDER,
];
