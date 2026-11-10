/**
 * VaultOrganizationsController checks — self-contained runner (node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/vault/modules/organizations/__tests__/vault-organizations.controller.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Stubs VaultService + OrganizationsGuard: org member read allowed, member
 * mutation 403, maintainer mutation allowed, non-uuid identity 401,
 * foreign/missing secret 404 (no ciphertext crosses the wire).
 */
import assert from 'node:assert/strict';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestIdentity } from '../../../../auth/identity.service';
import type { VaultConsumer, VaultSecret } from '@common/vault/vault.types';
import { VaultOrganizationsController } from '../vault-organizations.controller';

const ALICE: RequestIdentity = {
  id: '123e4567-e89b-12d3-a456-426614174001',
  email: 'alice@rush-code.local',
  mock: false,
};

const ORG_ID = '123e4567-e89b-12d3-a456-426614174010';
const SECRET_ID = '123e4567-e89b-12d3-a456-426614174020';

function storedSecret(): VaultSecret {
  return {
    id: SECRET_ID,
    consumerKind: 'org',
    consumerId: ORG_ID,
    provider: 'opencode',
    label: 'org-key',
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

let orgReadAllowed = true;
let orgMutationAllowed = true;

const orgGuard = {
  async memberRowOrThrow(
    orgId: string,
    userId: string,
  ): Promise<{ org: unknown; role: string }> {
    if (!orgReadAllowed) throw new NotFoundException('Organization not found');
    return { org: { id: orgId }, role: 'user' };
  },
  async maintainerOrThrow(
    orgId: string,
    userId: string,
  ): Promise<{ org: unknown; role: string }> {
    if (!orgMutationAllowed) {
      throw new ForbiddenException('Only organization maintainers can do this');
    }
    return { org: { id: orgId }, role: 'maintainer' };
  },
};

const controller: VaultOrganizationsController =
  new VaultOrganizationsController(vault as never, orgGuard as never);

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
    name: 'org member read is allowed and scopes the org consumer',
    run: async () => {
      calls.length = 0;
      orgReadAllowed = true;
      const list = await controller.listOrgSecrets(ORG_ID, ALICE);
      assert.equal(list.secrets.length, 1);
      assertNoCiphertext(list.secrets[0] as unknown as Record<string, unknown>);
      assert.deepEqual(calls[0].consumer, {
        kind: 'org',
        organizationId: ORG_ID,
      });
    },
  },
  {
    name: 'org stranger read answers 404 (no existence leak)',
    run: async () => {
      orgReadAllowed = false;
      await assert.rejects(
        () => controller.getOrgSecret(ORG_ID, SECRET_ID, ALICE),
        (error: unknown) => error instanceof NotFoundException,
      );
      orgReadAllowed = true;
    },
  },
  {
    name: 'org member mutation is denied 403',
    run: async () => {
      orgMutationAllowed = false;
      await assert.rejects(
        () =>
          controller.createOrgSecret(ORG_ID, ALICE, {
            provider: 'opencode',
            apiKey: 'b'.repeat(24),
          }),
        (error: unknown) => error instanceof ForbiddenException,
      );
      orgMutationAllowed = true;
    },
  },
  {
    name: 'org maintainer mutation is allowed',
    run: async () => {
      calls.length = 0;
      const info = await controller.createOrgSecret(ORG_ID, ALICE, {
        provider: 'opencode',
        apiKey: 'c'.repeat(24),
      });
      assert.equal(info.id, SECRET_ID);
      assertNoCiphertext(info as unknown as Record<string, unknown>);
      assert.deepEqual(calls[0].consumer, {
        kind: 'org',
        organizationId: ORG_ID,
      });
    },
  },
  {
    name: 'org foreign/missing secret answers 404 vault_secret_not_found',
    run: async () => {
      const foreignId = '123e4567-e89b-12d3-a456-426614174099';
      await assert.rejects(
        () => controller.getOrgSecret(ORG_ID, foreignId, ALICE),
        (error: unknown) => {
          assert.ok(error instanceof NotFoundException);
          const response = error.getResponse() as { code?: string };
          assert.equal(response.code, 'vault_secret_not_found');
          return true;
        },
      );
      await assert.rejects(
        () => controller.deleteOrgSecret(ORG_ID, foreignId, ALICE),
        (error: unknown) => error instanceof NotFoundException,
      );
    },
  },
  {
    name: 'non-uuid identity fails closed 401',
    run: async () => {
      await assert.rejects(
        () =>
          controller.listOrgSecrets(ORG_ID, {
            id: 'default',
            email: null,
            mock: true,
          }),
        (error: unknown) => error instanceof UnauthorizedException,
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
    console.log(`vault-organizations.controller: ${failed} failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`vault-organizations.controller: ${checks.length} passed`);
}

void main();
