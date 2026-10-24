/**
 * KEK rotation background pass — re-wraps stale per-user OpenCode API keys
 * under the active KEK.
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run keys:reencrypt`
 *
 * Rotation procedure (no downtime, no data loss):
 *   1. Deploy the new secret as OPENCODE_KEYS_ENCRYPTION_KEY (+
 *      OPENCODE_KEYS_ACTIVE_KEY_ID) and keep the old one as
 *      OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS (+ OPENCODE_KEYS_PREVIOUS_KEY_ID).
 *      Old rows keep decrypting via dual-read; GET /api/v1/usage lazily
 *      re-wraps rows on read.
 *   2. Run this pass (repeat until `stale` is 0) to converge rows that are
 *      never read.
 *   3. Drop OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS once `stale` stays 0.
 *
 * Strict Postgres (TEST_DATABASE_URL wins, DATABASE_URL fallback). Output is
 * counts only — user ids, ciphertext, and plaintext never reach the logs.
 * Unreadable rows (no known KEK opens them) are counted, never retried, and
 * fail the run (exit 1) so the rotation is never silently incomplete.
 */
async function main(): Promise<void> {
  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../app.module");
  const { CryptoService } = await import("./crypto.service");
  const { OpencodeKeysService } = await import("./opencode-keys.service");

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const crypto = app.get(CryptoService, { strict: false }) as InstanceType<typeof CryptoService>;
    const keys = app.get(OpencodeKeysService, { strict: false }) as InstanceType<typeof OpencodeKeysService>;

    let activeKeyId: string;
    try {
      activeKeyId = crypto.activeKeyId();
    } catch (err) {
      const code =
        (err as { getResponse?: () => { code?: string } }).getResponse?.()?.code ??
        "opencode_keys_unconfigured";
      process.stderr.write(`keys:reencrypt refused: ${code} (storage unconfigured)\n`);
      process.exitCode = 1;
      return;
    }

    const PAGE = 500;
    let scanned = 0;
    let reencrypted = 0;
    let unreadable = 0;
    // Converge in passes: each pass re-queries the stale set (re-wrapped
    // rows drop out). Stops when a pass makes no progress (only unreadable
    // rows remain) — unreadable rows are counted, never retried forever.
    for (;;) {
      const stale = await keys.findStaleUserIds(activeKeyId, PAGE);
      if (stale.length === 0) break;
      let progressed = false;
      for (const userId of stale) {
        scanned += 1;
        const stored = await keys.findByUserId(userId);
        if (!stored || crypto.isActiveKeyId(stored.keyId)) {
          progressed = true;
          continue;
        }
        let plain: string;
        try {
          plain = crypto.decrypt({
            keyId: stored.keyId,
            iv: stored.iv,
            data: stored.encryptedKey,
          });
        } catch {
          unreadable += 1;
          continue;
        }
        const fresh = crypto.encrypt(plain);
        await keys.save(userId, {
          encryptedKey: fresh.data,
          iv: fresh.iv,
          keyId: fresh.keyId,
        });
        reencrypted += 1;
        progressed = true;
      }
      if (!progressed || stale.length < PAGE) break;
    }
    process.stdout.write(
      `keys:reencrypt done: ${JSON.stringify({ scanned, reencrypted, unreadable, activeKeyId })}\n`,
    );
    if (unreadable > 0) {
      process.stderr.write(
        `keys:reencrypt: ${unreadable} row(s) unreadable with the configured KEKs — ` +
          "restore the wrapping KEK as OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS and rerun\n",
      );
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`keys:reencrypt failed to run: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
