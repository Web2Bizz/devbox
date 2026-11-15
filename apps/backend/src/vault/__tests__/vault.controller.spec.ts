/**
 * VaultController checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/vault/__tests__/vault.controller.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Stubs VaultService: mapping (no ciphertext leak), ownership 404s, non-uuid
 * identity 401. Organization-scoped routes are covered by
 * `modules/organizations/__tests__/vault-organizations.controller.spec.ts`.
 */
import assert from 'node:assert/strict';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestIdentity } from '../../auth/identity.service';
import type { VaultConsumer, VaultSecret } from '@common/vault/vault.types';
import { VaultController } from '../vault.controller';

const ALICE: RequestIdentity = {
  id: '123e4567-e89b-12d3-a456-426614174001',
  email: 'alice@rush-code.local',
  mock: false,
};

const SECRET_ID = '123e4567-e89b-12d3-a456-426614174020';

function storedSecret(): VaultSecret {
  return {
    id: SECRET_ID,
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

type VaultCall = {
  method: string;
  consumer: VaultConsumer;
  id?: string;
  body?: unknown;
};

const calls: Array<VaultCall> = [];

const vault = {
  async create(
    consumer: VaultConsumer,
    body: unknown,
  ): Promise<VaultSecret> {
    calls.push({ method: 'create', consumer, body });
    return storedSecret();
  },
  async list(consumer: VaultConsumer): Promise<Array<VaultSecret>> {
    calls.push({ method: 'list', consumer });
    return [storedSecret()];
  },
  async get(
    consumer: VaultConsumer,
    id: string,
  ): Promise<VaultSecret | null> {
    calls.push({ method: 'get', consumer, id });
    return id === SECRET_ID ? storedSecret() : null;
  },
  async update(
    consumer: VaultConsumer,
    id: string,
    body: unknown,
  ): Promise<VaultSecret | null> {
    calls.push({ method: 'update', consumer, id, body });
    return id === SECRET_ID
      ? { ...storedSecret(), label: 'rotated' }
      : null;
  },
  async remove(consumer: VaultConsumer, id: string): Promise<boolean> {
    calls.push({ method: 'remove', consumer, id });
    return id === SECRET_ID;
  },
};

const controller: VaultController = new VaultController(vault as never);

function assertNoCiphertext(value: Record<string, unknown>): void {
  for (const forbidden of ['encryptedKey', 'iv', 'keyId', 'apiKey']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(value, forbidden),
      false,
      `${forbidden} must never cross the wire`,
    );
  }
}

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: 'POST /vault/secrets maps to info and scopes the user consumer',
    run: async () => {
      calls.length = 0;
      const info = await controller.createSecret(ALICE, {
        provider: 'opencode',
        apiKey: 'a'.repeat(24),
        label: 'primary',
      });
      assert.deepEqual(info, {
        id: SECRET_ID,
        provider: 'opencode',
        label: 'primary',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      assertNoCiphertext(info as unknown as Record<string, unknown>);
      assert.deepEqual(calls[0].consumer, { kind: 'user', userId: ALICE.id });
    },
  },
  {
    name: 'GET /vault/secrets lists the user consumer without ciphertext',
    run: async () => {
      calls.length = 0;
      const list = await controller.listSecrets(ALICE);
      assert.equal(list.secrets.length, 1);
      assertNoCiphertext(list.secrets[0] as unknown as Record<string, unknown>);
      assert.deepEqual(calls[0].consumer, { kind: 'user', userId: ALICE.id });
    },
  },
  {
    name: 'GET /vault/secrets/:id maps one secret',
    run: async () => {
      const info = await controller.getSecret(SECRET_ID, ALICE);
      assert.equal(info.id, SECRET_ID);
      assertNoCiphertext(info as unknown as Record<string, unknown>);
    },
  },
  {
    name: 'PUT /vault/secrets/:id maps the updated label',
    run: async () => {
      const info = await controller.updateSecret(SECRET_ID, ALICE, {
        label: 'rotated',
      });
      assert.equal(info.label, 'rotated');
      assertNoCiphertext(info as unknown as Record<string, unknown>);
    },
  },
  {
    name: 'DELETE /vault/secrets/:id answers { ok: true }',
    run: async () => {
      const result = await controller.deleteSecret(SECRET_ID, ALICE);
      assert.deepEqual(result, { ok: true });
    },
  },
  {
    name: 'foreign/missing id answers 404 vault_secret_not_found',
    run: async () => {
      const foreignId = '123e4567-e89b-12d3-a456-426614174099';
      await assert.rejects(
        () => controller.getSecret(foreignId, ALICE),
        (error: unknown) => {
          assert.ok(error instanceof NotFoundException);
          const response = error.getResponse() as { code?: string };
          assert.equal(response.code, 'vault_secret_not_found');
          return true;
        },
      );
      await assert.rejects(
        () => controller.deleteSecret(foreignId, ALICE),
        (error: unknown) => error instanceof NotFoundException,
      );
    },
  },
  {
    name: 'non-uuid identity fails closed 401',
    run: async () => {
      await assert.rejects(
        () =>
          controller.listSecrets({
            id: 'default',
            email: null,
            mock: true,
          }),
        (error: unknown) => {
          assert.ok(error instanceof UnauthorizedException);
          return true;
        },
      );
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok   - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.log(`vault.controller: ${failed} failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`vault.controller: ${checks.length} passed`);
}

void main();
