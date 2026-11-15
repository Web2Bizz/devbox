/**
 * VaultService round-robin checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/common/vault/__tests__/vault.service.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers: two stored secrets → alternating picks, per-provider cursors stay
 * independent, no secrets → null.
 */
import assert from 'node:assert/strict';
import { VaultService } from '../vault.service';
import type { VaultConsumer, VaultSecret } from '../vault.types';

const CONSUMER: VaultConsumer = {
  kind: 'user',
  userId: '11111111-1111-4111-8111-111111111111',
};

function secret(id: string, provider: string): VaultSecret {
  return {
    id,
    consumerKind: 'user',
    consumerId: CONSUMER.kind === 'user' ? CONSUMER.userId : '',
    provider,
    label: id,
    encryptedKey: `enc-${id}`,
    iv: `iv-${id}`,
    keyId: 'v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const OPENCODE_SECRETS: Array<VaultSecret> = [
  secret('secret-a', 'opencode'),
  secret('secret-b', 'opencode'),
];

const OPENROUTER_SECRETS: Array<VaultSecret> = [
  secret('secret-c', 'openrouter'),
];

const repository = {
  async list(
    _consumer: VaultConsumer,
    provider?: string,
  ): Promise<Array<VaultSecret>> {
    if (provider === 'opencode') return OPENCODE_SECRETS;
    if (provider === 'openrouter') return OPENROUTER_SECRETS;
    return [];
  },
};

const crypto = {
  encrypt: () => ({ keyId: 'v1', iv: 'iv', data: 'data' }),
};

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const service: VaultService = new VaultService(
  repository as never,
  crypto as never,
  logger as never,
);

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: 'round-robin: two keys alternate a → b → a',
    run: async () => {
      const first: VaultSecret | null = await service.pickNext(
        CONSUMER,
        'opencode',
      );
      const second: VaultSecret | null = await service.pickNext(
        CONSUMER,
        'opencode',
      );
      const third: VaultSecret | null = await service.pickNext(
        CONSUMER,
        'opencode',
      );
      assert.equal(first?.id, 'secret-a');
      assert.equal(second?.id, 'secret-b');
      assert.equal(third?.id, 'secret-a');
    },
  },
  {
    name: 'round-robin: provider cursors stay independent',
    run: async () => {
      const picked: VaultSecret | null = await service.pickNext(
        CONSUMER,
        'openrouter',
      );
      assert.equal(picked?.id, 'secret-c');
      // opencode cursor keeps its own position (was advanced to b).
      const after: VaultSecret | null = await service.pickNext(
        CONSUMER,
        'opencode',
      );
      assert.equal(after?.id, 'secret-b');
    },
  },
  {
    name: 'round-robin: no secrets → null (no throw)',
    run: async () => {
      const picked: VaultSecret | null = await service.pickNext(
        CONSUMER,
        'missing-provider',
      );
      assert.equal(picked, null);
    },
  },
];

async function main(): Promise<void> {
  let failed: number = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} vault service checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} vault service checks failed`);
  }
  console.log(`${checks.length}/${checks.length} vault service checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`vault service checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
