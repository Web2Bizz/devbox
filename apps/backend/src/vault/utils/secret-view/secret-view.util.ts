/**
 * secret-view pure functions — shared by the user (`vault.controller.ts`) and
 * organization (`modules/organizations/vault-organizations.controller.ts`)
 * vault surfaces. No side effects, no DI, no logger ownership: callers pass
 * what the function needs and every const/return carries an explicit type
 * (CoC root §5).
 *
 * - `ownUserId` — the fail-closed identity check used by both controllers
 *   (non-uuid mock identities → 401 instead of a driver error).
 * - `toInfo` — stored secret → wire shape; ciphertext/iv/keyId never leave
 *   the server.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { VaultSecretInfo } from '@rush-code/contracts';
import type { VaultSecret } from '@common/vault/vault.types';
import { uuidSchema } from '@common/validation';
import type { RequestIdentity } from '../../../auth/identity.service';

/** Fail-closed identity check: non-uuid identities answer 401, never a driver error. */
export function ownUserId(identity: RequestIdentity): string {
  if (!uuidSchema.safeParse(identity.id).success) {
    throw new UnauthorizedException({
      code: 'unauthorized',
      message: 'Authentication required',
    });
  }
  return identity.id;
}

/** Stored secret → wire shape (ciphertext/iv/keyId never leave the server). */
export function toInfo(secret: VaultSecret): VaultSecretInfo {
  return {
    id: secret.id,
    provider: secret.provider,
    label: secret.label,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  };
}
