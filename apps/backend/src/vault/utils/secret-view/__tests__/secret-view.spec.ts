/**
 * secret-view util checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/vault/utils/secret-view/__tests__/secret-view.spec.js`
 * Also executes under `bun run test` (top-level run, throws on failure).
 *
 * Covers: uuid accept/reject, `toInfo` omits ciphertext/iv/keyId, `ownUserId`
 * fail-closed 401 on non-uuid identities.
 */
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import type { VaultSecretInfo } from '@rush-code/contracts';
import type { RequestIdentity } from '../../../../auth/identity.service';
import type { VaultSecret } from '@common/vault/vault.types';
import { uuidSchema } from '@common/validation';
import { ownUserId, toInfo } from '../secret-view.util';

const ALICE: RequestIdentity = {
  id: '123e4567-e89b-12d3-a456-426614174001',
  email: 'alice@rush-code.local',
  mock: false,
};

const MOCK_IDENTITY: RequestIdentity = {
  id: 'default',
  email: null,
  mock: true,
};

function storedSecret(): VaultSecret {
  return {
    id: '123e4567-e89b-12d3-a456-426614174020',
    consumerKind: 'user',
    consumerId: ALICE.id,
    provider: 'opencode',
    label: 'primary',
    encryptedKey: 'ciphertext-must-not-leak',
    iv: 'iv-must-not-leak',
    keyId: 'v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function checks(): void {
  // uuid accept/reject (zod schema is the single validation source)
  assert.ok(uuidSchema.safeParse(ALICE.id).success);
  assert.ok(uuidSchema.safeParse('123E4567-E89B-12D3-A456-426614174001').success, 'uppercase uuid');
  assert.ok(!uuidSchema.safeParse(MOCK_IDENTITY.id).success);
  assert.ok(!uuidSchema.safeParse('').success);
  assert.ok(!uuidSchema.safeParse('123e4567-e89b-12d3-a456-42661417400').success);
  assert.ok(!uuidSchema.safeParse('123e4567e89b12d3a456426614174001').success);

  // toInfo — wire shape omits ciphertext/iv/keyId
  const info: VaultSecretInfo = toInfo(storedSecret());
  assert.deepEqual(info, {
    id: '123e4567-e89b-12d3-a456-426614174020',
    provider: 'opencode',
    label: 'primary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  const infoKeys: Array<string> = Object.keys(info).sort();
  assert.deepEqual(infoKeys, ['createdAt', 'id', 'label', 'provider', 'updatedAt']);
  const serialized: string = JSON.stringify(info);
  assert.ok(!serialized.includes('ciphertext'), 'ciphertext must not leak');
  assert.ok(!serialized.includes('iv-must-not-leak'), 'iv must not leak');
  assert.ok(!serialized.includes('keyId'), 'keyId must not leak');

  // ownUserId — uuid passes through, mock identity 401s fail-closed
  assert.equal(ownUserId(ALICE), ALICE.id);
  let unauthorized: unknown = null;
  try {
    ownUserId(MOCK_IDENTITY);
  } catch (error: unknown) {
    unauthorized = error;
  }
  assert.ok(unauthorized instanceof UnauthorizedException);
  assert.equal((unauthorized as UnauthorizedException).getStatus(), 401);
}

checks();
