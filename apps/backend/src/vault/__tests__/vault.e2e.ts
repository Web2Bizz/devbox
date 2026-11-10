/**
 * Vault e2e — self-contained runner (plain fetch, no new deps).
 *
 * Runs against COMPILED dist (tsc decorator metadata; do not run via
 * `bun test` on TS sources). Usage:
 *   `bun run build && bun dist/vault/__tests__/vault.e2e.js`
 *
 * Strict Postgres via testcontainers (`startTestDb` from
 * common/db/e2e-db.container; migrations applied automatically). Covers:
 * - user CRUD, write-only key (no apiKey/ciphertext in responses), ownership
 *   isolation (user B cannot read/delete user A's secret → 404);
 * - org surface: maintainer creates, member reads, stranger 404, member
 *   mutation 403, maintainer rotates and deletes;
 * - at-rest proof: rows are read back straight from Postgres and must hold
 *   ciphertext (no plaintext inside encrypted_key/iv) that CryptoService
 *   decrypts back to the submitted key — after both POST and PUT, for user
 *   and org consumers;
 * - orphan cleanup: deleting a user removes the user's vault rows in the
 *   same transaction (no FK on the polymorphic consumer_id);
 * - log scan: AppLogger messages for the whole suite (patched before boot)
 *   never contain a raw key, `Bearer `, `http://` or `https://`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool as PgPool } from 'pg';
import type { CryptoService as CryptoServiceInstance } from '../../common/crypto/crypto.service';

// Deterministic env — BEFORE AppModule import (ConfigModule.validate at import).
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-not-real-0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-not-real-0123456789';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '7d';
process.env.AUTH_LEGACY_MOCK_FALLBACK = 'false';
// Vault writes encrypt at rest — a ≥32-char KEK must exist in the e2e process.
process.env.OPENCODE_KEYS_ENCRYPTION_KEY =
  'e2e-vault-encryption-key-not-real-0123456789';

type SecretInfo = {
  id?: string;
  provider?: string;
  label?: string;
  createdAt?: string;
  updatedAt?: string;
  apiKey?: string;
  encryptedKey?: string;
  iv?: string;
};

type VaultAtRestRow = {
  encrypted_key: string;
  iv: string;
  key_id: string;
};

/**
 * Structural view of the AppLogger prototype used by the log scan. Patching
 * the real prototype (rather than a local logger instance) covers every
 * `new AppLogger(...)` in the process — including module boot.
 */
type ProtoLogger = {
  debug: (message: unknown, correlationId?: string) => void;
  info: (message: unknown, correlationId?: string) => void;
  warn: (message: unknown, correlationId?: string) => void;
  error: (
    message: unknown,
    stackOrCorrelationId?: string,
    correlationId?: string,
  ) => void;
};

async function main(): Promise<void> {
  const { startTestDb } = await import('../../common/db/e2e-db.container');
  const testDb = await startTestDb();
  process.env.DATABASE_URL = testDb.url;
  for (const key of [
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_DB',
    'POSTGRES_HOST',
  ]) {
    delete process.env[key];
  }
  console.log(`[vault e2e] db mode: ${testDb.mode}`);

  // Isolate on-disk repos in a tmp REPOS_ROOT — set before app boot.
  const reposRoot = await mkdtemp(path.join(tmpdir(), 'rush-code-vault-e2e-'));
  process.env.REPOS_ROOT = reposRoot;
  console.log(`[vault e2e] REPOS_ROOT: ${reposRoot}`);

  const { NestFactory } = await import('@nestjs/core');
  const { AppLogger } = await import('../../common/logger');
  const { AppModule } = await import('../../app/app.module');
  const { configureApp } = await import('../../app/app.setup');

  // Log scan: capture every AppLogger message for the WHOLE suite, before
  // NestFactory.create so module boot lines are covered too. The wrapped
  // methods still call the originals (log behaviour is unchanged).
  const capturedLogs: Array<string> = [];
  const proto: ProtoLogger = AppLogger.prototype;
  const originalLoggerMethods: ProtoLogger = {
    debug: proto.debug,
    info: proto.info,
    warn: proto.warn,
    error: proto.error,
  };
  const capture = (message: unknown): void => {
    capturedLogs.push(typeof message === 'string' ? message : String(message));
  };
  proto.debug = function (
    this: unknown,
    message: unknown,
    correlationId?: string,
  ): void {
    capture(message);
    originalLoggerMethods.debug.call(this, message, correlationId);
  };
  proto.info = function (
    this: unknown,
    message: unknown,
    correlationId?: string,
  ): void {
    capture(message);
    originalLoggerMethods.info.call(this, message, correlationId);
  };
  proto.warn = function (
    this: unknown,
    message: unknown,
    correlationId?: string,
  ): void {
    capture(message);
    originalLoggerMethods.warn.call(this, message, correlationId);
  };
  proto.error = function (
    this: unknown,
    message: unknown,
    stackOrCorrelationId?: string,
    correlationId?: string,
  ): void {
    capture(message);
    originalLoggerMethods.error.call(
      this,
      message,
      stackOrCorrelationId,
      correlationId,
    );
  };

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  const base = await app.getUrl();
  const { CryptoService } = await import('../../common/crypto/crypto.service');
  const cryptoService: CryptoServiceInstance = app.get(CryptoService, {
    strict: false,
  });
  let pool: PgPool | undefined;
  const scannedSecrets: Array<string> = [];
  let passed = 0;
  let failed = 0;

  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      passed += 1;
      console.log(`ok   - ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL - ${name}: ${(error as Error).message}`);
    }
  }

  /** Reads the row straight from Postgres and proves it holds ciphertext. */
  async function assertAtRest(
    secretId: string,
    expectedPlaintext: string,
  ): Promise<void> {
    assert.ok(pool, 'pg pool must be open in live mode');
    const result = await pool.query<VaultAtRestRow>(
      'SELECT encrypted_key, iv, key_id FROM vault_secrets WHERE id = $1',
      [secretId],
    );
    assert.equal(result.rowCount, 1, 'exactly one vault row must exist');
    const row: VaultAtRestRow = result.rows[0];
    assert.equal(
      row.encrypted_key.includes(expectedPlaintext),
      false,
      'plaintext must never appear in encrypted_key',
    );
    assert.equal(
      row.iv.includes(expectedPlaintext),
      false,
      'plaintext must never appear in iv',
    );
    const decrypted: string = cryptoService.decrypt({
      keyId: row.key_id,
      iv: row.iv,
      data: row.encrypted_key,
    });
    assert.equal(decrypted, expectedPlaintext);
  }

  const json = (
    body: unknown,
    method = 'POST',
    token?: string,
  ): {
    method: string;
    headers: Record<string, string>;
    body: string;
  } => ({
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const auth = (
    token?: string,
    extra?: Record<string, string>,
  ): { headers: Record<string, string> } => ({
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
  });
  const readJson = async (response: Response): Promise<unknown> =>
    (await response.json().catch(() => null)) as unknown;

  try {
    if (testDb.mode === 'unreachable') {
      // No live PG — the store answers 503, never a memory fallback.
      const { TokenService } = await import('../../auth/token.service');
      const tokens = app.get(TokenService, { strict: false }) as {
        sign: (
          claims: Record<string, unknown>,
          secret: string,
          ttlSec: number,
        ) => { token: string };
      };
      const probe = tokens.sign(
        {
          sub: '123e4567-e89b-12d3-a456-426614174001',
          email: 'probe@rush-code.local',
          typ: 'access',
        },
        process.env.JWT_ACCESS_SECRET as string,
        900,
      ).token;

      await check('GET /api/v1/vault/secrets without Bearer → 401', async () => {
        const response = await fetch(`${base}/api/v1/vault/secrets`);
        assert.equal(response.status, 401);
        assert.equal(
          ((await readJson(response)) as { code?: string }).code,
          'unauthorized',
        );
      });

      await check(
        'GET /api/v1/vault/secrets without PG → 503 EXTERNAL_UNAVAILABLE',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/secrets`,
            auth(probe),
          );
          assert.equal(response.status, 503);
          assert.equal(
            ((await readJson(response)) as { code?: string }).code,
            'EXTERNAL_UNAVAILABLE',
          );
          assert.equal(response.headers.get('retry-after'), '30');
        },
      );
    } else {
      const { Pool } = await import('pg');
      pool = new Pool({ connectionString: testDb.url });

      async function register(
        tag: string,
      ): Promise<{ id: string; token: string }> {
        const response = await fetch(
          `${base}/api/v1/auth/register`,
          json({
            firstName: 'Vault',
            lastName: tag,
            email: `vault-e2e-${tag}@rush-code.local`,
            password: 's3cret-p4ss',
          }),
        );
        assert.equal(response.status, 201);
        const body = (await readJson(response)) as {
          user?: { id?: string };
          accessToken?: string;
        };
        return {
          id: body.user?.id as string,
          token: body.accessToken as string,
        };
      }

      const alice = await register('alice');
      const bob = await register('bob');
      const carol = await register('carol');
      assert.ok(alice.id && bob.id && carol.id);

      const userKey = `sk-opencode-e2e-${'a'.repeat(24)}`;
      const userRotatedKey = `sk-opencode-e2e-${'d'.repeat(24)}`;
      const orgKey = `sk-or-e2e-${'b'.repeat(24)}`;
      const orgRotatedKey = `sk-or-e2e-${'e'.repeat(24)}`;
      const cleanupKey = `sk-opencode-e2e-${'f'.repeat(24)}`;
      scannedSecrets.push(
        userKey,
        userRotatedKey,
        orgKey,
        orgRotatedKey,
        cleanupKey,
      );
      let userSecretId = '';
      let orgId = '';
      let orgSecretId = '';

      await check(
        'POST /api/v1/vault/secrets 201 (write-only key, no ciphertext)',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/secrets`,
            json(
              { provider: 'opencode', apiKey: userKey, label: 'primary' },
              'POST',
              alice.token,
            ),
          );
          assert.equal(response.status, 201);
          const body = (await readJson(response)) as SecretInfo;
          assert.ok(body.id);
          assert.equal(body.provider, 'opencode');
          assert.equal(body.label, 'primary');
          assert.ok(body.createdAt);
          assert.ok(body.updatedAt);
          assert.equal(body.apiKey, undefined);
          assert.equal(body.encryptedKey, undefined);
          assert.equal(body.iv, undefined);
          userSecretId = body.id as string;
        },
      );

      await check(
        'POST user secret is ciphertext at rest and decrypts to the key',
        async () => {
          await assertAtRest(userSecretId, userKey);
        },
      );

      await check(
        'POST /api/v1/vault/secrets rejects a too-short key 400',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/secrets`,
            json(
              { provider: 'opencode', apiKey: 'short' },
              'POST',
              alice.token,
            ),
          );
          assert.equal(response.status, 400);
        },
      );

      await check(
        'GET /api/v1/vault/secrets lists the owner secret',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/secrets`,
            auth(alice.token),
          );
          assert.equal(response.status, 200);
          const body = (await readJson(response)) as {
            secrets?: Array<SecretInfo>;
          };
          assert.equal(body.secrets?.length, 1);
          assert.equal(body.secrets?.[0].id, userSecretId);
          assert.equal(body.secrets?.[0].apiKey, undefined);
        },
      );

      await check('GET /api/v1/vault/secrets/:id 200 for the owner', async () => {
        const response = await fetch(
          `${base}/api/v1/vault/secrets/${userSecretId}`,
          auth(alice.token),
        );
        assert.equal(response.status, 200);
        assert.equal(
          ((await readJson(response)) as SecretInfo).id,
          userSecretId,
        );
      });

      await check(
        'PUT /api/v1/vault/secrets/:id rotates the key and re-encrypts',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/secrets/${userSecretId}`,
            json(
              { apiKey: userRotatedKey, label: 'rotated' },
              'PUT',
              alice.token,
            ),
          );
          assert.equal(response.status, 200);
          const body = (await readJson(response)) as SecretInfo;
          assert.equal(body.label, 'rotated');
          assert.equal(body.apiKey, undefined);
          assert.equal(body.encryptedKey, undefined);
        },
      );

      await check(
        'PUT user secret is ciphertext at rest and decrypts to the new key',
        async () => {
          await assertAtRest(userSecretId, userRotatedKey);
        },
      );

      await check(
        'user B cannot read user A secret → 404',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/secrets/${userSecretId}`,
            auth(bob.token),
          );
          assert.equal(response.status, 404);
          assert.equal(
            ((await readJson(response)) as { code?: string }).code,
            'vault_secret_not_found',
          );
        },
      );

      await check(
        'user B cannot delete user A secret → 404 (row stays)',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/secrets/${userSecretId}`,
            { method: 'DELETE', ...auth(bob.token) },
          );
          assert.equal(response.status, 404);
          const still = await fetch(
            `${base}/api/v1/vault/secrets/${userSecretId}`,
            auth(alice.token),
          );
          assert.equal(still.status, 200);
        },
      );

      await check(
        'DELETE /api/v1/vault/secrets/:id { ok: true }, replay 404',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/secrets/${userSecretId}`,
            { method: 'DELETE', ...auth(alice.token) },
          );
          assert.equal(response.status, 200);
          assert.deepEqual(await readJson(response), { ok: true });
          const replay = await fetch(
            `${base}/api/v1/vault/secrets/${userSecretId}`,
            { method: 'DELETE', ...auth(alice.token) },
          );
          assert.equal(replay.status, 404);
        },
      );

      await check('POST /api/v1/organizations 201 for alice', async () => {
        const response = await fetch(
          `${base}/api/v1/organizations`,
          json({ name: 'vault-acme' }, 'POST', alice.token),
        );
        assert.equal(response.status, 201);
        const body = (await readJson(response)) as { id?: string };
        assert.ok(body.id);
        orgId = body.id as string;
      });

      await check('add bob as a plain member', async () => {
        const response = await fetch(
          `${base}/api/v1/organizations/${orgId}/members`,
          json({ userId: bob.id, role: 'user' }, 'POST', alice.token),
        );
        assert.equal(response.status, 201);
      });

      await check(
        'org maintainer creates a secret 201',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/organizations/${orgId}/secrets`,
            json(
              {
                provider: 'openrouter',
                apiKey: orgKey,
                label: 'org-key',
              },
              'POST',
              alice.token,
            ),
          );
          assert.equal(response.status, 201);
          const body = (await readJson(response)) as SecretInfo;
          assert.ok(body.id);
          assert.equal(body.label, 'org-key');
          assert.equal(body.encryptedKey, undefined);
          orgSecretId = body.id as string;
        },
      );

      await check(
        'POST org secret is ciphertext at rest and decrypts to the key',
        async () => {
          await assertAtRest(orgSecretId, orgKey);
        },
      );

      await check('org member reads the secret list', async () => {
        const response = await fetch(
          `${base}/api/v1/vault/organizations/${orgId}/secrets`,
          auth(bob.token),
        );
        assert.equal(response.status, 200);
        const body = (await readJson(response)) as {
          secrets?: Array<SecretInfo>;
        };
        assert.ok(body.secrets?.some((secret) => secret.id === orgSecretId));
      });

      await check('org member reads one secret', async () => {
        const response = await fetch(
          `${base}/api/v1/vault/organizations/${orgId}/secrets/${orgSecretId}`,
          auth(bob.token),
        );
        assert.equal(response.status, 200);
        assert.equal(
          ((await readJson(response)) as SecretInfo).id,
          orgSecretId,
        );
      });

      await check('org stranger gets 404 (no existence leak)', async () => {
        const response = await fetch(
          `${base}/api/v1/vault/organizations/${orgId}/secrets`,
          auth(carol.token),
        );
        assert.equal(response.status, 404);
      });

      await check('org member mutation → 403', async () => {
        const created = await fetch(
          `${base}/api/v1/vault/organizations/${orgId}/secrets`,
          json(
            {
              provider: 'openrouter',
              apiKey: `sk-or-e2e-${'c'.repeat(24)}`,
            },
            'POST',
            bob.token,
          ),
        );
        assert.equal(created.status, 403);
        const updated = await fetch(
          `${base}/api/v1/vault/organizations/${orgId}/secrets/${orgSecretId}`,
          json({ label: 'hijack' }, 'PUT', bob.token),
        );
        assert.equal(updated.status, 403);
        const removed = await fetch(
          `${base}/api/v1/vault/organizations/${orgId}/secrets/${orgSecretId}`,
          { method: 'DELETE', ...auth(bob.token) },
        );
        assert.equal(removed.status, 403);
      });

      await check(
        'org maintainer rotates the key and re-encrypts at rest',
        async () => {
          const response = await fetch(
            `${base}/api/v1/vault/organizations/${orgId}/secrets/${orgSecretId}`,
            json(
              { apiKey: orgRotatedKey, label: 'org-key-rotated' },
              'PUT',
              alice.token,
            ),
          );
          assert.equal(response.status, 200);
          const body = (await readJson(response)) as SecretInfo;
          assert.equal(body.label, 'org-key-rotated');
          assert.equal(body.apiKey, undefined);
          await assertAtRest(orgSecretId, orgRotatedKey);
        },
      );

      await check(
        'user deletion removes the user vault rows (no FK to cascade)',
        async () => {
          const dave = await register('dave');
          const created = await fetch(
            `${base}/api/v1/vault/secrets`,
            json(
              { provider: 'opencode', apiKey: cleanupKey },
              'POST',
              dave.token,
            ),
          );
          assert.equal(created.status, 201);
          assert.ok(pool, 'pg pool must be open in live mode');
          const before = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM vault_secrets WHERE consumer_type='user' AND consumer_id=$1",
            [dave.id],
          );
          assert.equal(before.rows[0].count, 1);
          const { UsersRepository } = await import(
            '../../users/users.repository'
          );
          const usersRepository = app.get(UsersRepository, {
            strict: false,
          }) as { deleteById: (id: string) => Promise<void> };
          await usersRepository.deleteById(dave.id);
          const after = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM vault_secrets WHERE consumer_type='user' AND consumer_id=$1",
            [dave.id],
          );
          assert.equal(after.rows[0].count, 0);
        },
      );

      await check('org maintainer deletes the secret', async () => {
        const response = await fetch(
          `${base}/api/v1/vault/organizations/${orgId}/secrets/${orgSecretId}`,
          { method: 'DELETE', ...auth(alice.token) },
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await readJson(response), { ok: true });
      });
    }

    await check(
      'logs never contain raw keys, Bearer or URLs',
      async () => {
        const logs: string = capturedLogs.join('\n');
        for (const raw of scannedSecrets) {
          assert.equal(
            logs.includes(raw),
            false,
            'AppLogger output must never contain a raw key',
          );
        }
        assert.equal(logs.includes('Bearer '), false);
        assert.equal(logs.includes('http://'), false);
        assert.equal(logs.includes('https://'), false);
      },
    );
  } finally {
    proto.debug = originalLoggerMethods.debug;
    proto.info = originalLoggerMethods.info;
    proto.warn = originalLoggerMethods.warn;
    proto.error = originalLoggerMethods.error;
    await app.close();
    if (pool) {
      await pool.end().catch(() => undefined);
    }
    await testDb.stop();
    await rm(reposRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  console.log(`[vault e2e] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(`[vault e2e] fatal: ${(error as Error).message}`);
  process.exitCode = 1;
});
