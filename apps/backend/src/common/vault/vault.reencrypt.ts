/**
 * KEK rotation background pass — re-wraps stale vault secrets under the
 * active KEK.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run keys:reencrypt`
 *
 * Rotation procedure (no downtime, no data loss):
 *   1. Deploy the new secret as OPENCODE_KEYS_ENCRYPTION_KEY (+
 *      OPENCODE_KEYS_ACTIVE_KEY_ID) and keep the old one as
 *      OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS (+ OPENCODE_KEYS_PREVIOUS_KEY_ID).
 *      Old rows keep decrypting via dual-read; key consumers lazily re-wrap
 *      rows on read.
 *   2. Run this pass (repeat until `stale` is 0) to converge rows that are
 *      never read.
 *   3. Drop OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS once `stale` stays 0.
 *
 * Strict Postgres (TEST_DATABASE_URL wins, DATABASE_URL fallback). Output is
 * counts only — consumer ids, ciphertext, and plaintext never reach the logs.
 * Unreadable rows (no known KEK opens them) are counted, never retried, and
 * fail the run (exit 1) so the rotation is never silently incomplete.
 */
import type { INestApplicationContext } from '@nestjs/common';
import type { EncryptedOpencodeKey } from '../crypto/crypto.service';
import type {
  StaleVaultSecret,
  VaultConsumer,
  VaultSecret,
} from './vault.types';

/** Rows fetched per stale-set query (bigger pages = fewer round trips). */
const PAGE_SIZE: number = 500;

/** Stale identity → the consumer it belongs to. */
function consumerOf(stale: StaleVaultSecret): VaultConsumer {
  return stale.consumerKind === 'org'
    ? { kind: 'org', organizationId: stale.consumerId }
    : { kind: 'user', userId: stale.consumerId };
}

async function main(): Promise<void> {
  const { NestFactory }: typeof import('@nestjs/core') = await import(
    '@nestjs/core'
  );
  const { AppModule }: typeof import('../../app/app.module') = await import(
    '../../app/app.module'
  );
  const { CryptoService }: typeof import('../crypto/crypto.service') =
    await import('../crypto/crypto.service');
  const { VaultRepository }: typeof import('./vault.repository') =
    await import('./vault.repository');

  const app: INestApplicationContext =
    await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
  try {
    const cryptoService: InstanceType<typeof CryptoService> = app.get(
      CryptoService,
      { strict: false },
    ) as InstanceType<typeof CryptoService>;
    const vault: InstanceType<typeof VaultRepository> = app.get(
      VaultRepository,
      { strict: false },
    ) as InstanceType<typeof VaultRepository>;

    let activeKeyId: string;
    try {
      activeKeyId = cryptoService.activeKeyId();
    } catch (error) {
      const code: string =
        (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code ??
        'opencode_keys_unconfigured';
      process.stderr.write(
        `keys:reencrypt refused: ${code} (storage unconfigured)\n`,
      );
      process.exitCode = 1;
      return;
    }

    let scanned: number = 0;
    let reencrypted: number = 0;
    let unreadable: number = 0;
    // Converge in passes: each pass re-queries the stale set (re-wrapped
    // rows drop out). Stops when a pass makes no progress (only unreadable
    // rows remain) — unreadable rows are counted, never retried forever.
    for (;;) {
      const stale: Array<StaleVaultSecret> = await vault.findStale(
        activeKeyId,
        PAGE_SIZE,
      );
      if (stale.length === 0) break;
      let progressed: boolean = false;
      for (const entry of stale) {
        scanned += 1;
        const stored: VaultSecret | null = await vault.findById(
          consumerOf(entry),
          entry.id,
        );
        if (!stored || cryptoService.isActiveKeyId(stored.keyId)) {
          progressed = true;
          continue;
        }
        let plain: string;
        try {
          plain = cryptoService.decrypt({
            keyId: stored.keyId,
            iv: stored.iv,
            data: stored.encryptedKey,
          });
        } catch {
          unreadable += 1;
          continue;
        }
        const fresh: EncryptedOpencodeKey = cryptoService.encrypt(plain);
        await vault.updateById(entry.id, {
          encryptedKey: fresh.data,
          iv: fresh.iv,
          keyId: fresh.keyId,
        });
        reencrypted += 1;
        progressed = true;
      }
      if (!progressed || stale.length < PAGE_SIZE) break;
    }
    process.stdout.write(
      `keys:reencrypt done: ${JSON.stringify({
        scanned,
        reencrypted,
        unreadable,
        activeKeyId,
      })}\n`,
    );
    if (unreadable > 0) {
      process.stderr.write(
        `keys:reencrypt: ${unreadable} row(s) unreadable with the configured KEKs — ` +
          'restore the wrapping KEK as OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS and rerun\n',
      );
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `keys:reencrypt failed to run: ${(error as Error).message}\n`,
  );
  process.exitCode = 1;
});
