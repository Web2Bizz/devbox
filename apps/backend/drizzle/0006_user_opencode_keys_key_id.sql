-- KEK rotation for per-user OpenCode API keys (backward-compatible).
--
-- Strategy: rows carry the wrapping KEK version (`key_id`, plaintext, never
-- a secret) so decrypt can dual-read across the rotation window:
--   1. Deploy the new secret as OPENCODE_KEYS_ENCRYPTION_KEY (+
--      OPENCODE_KEYS_ACTIVE_KEY_ID) and keep the old one as
--      OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS (+ OPENCODE_KEYS_PREVIOUS_KEY_ID).
--   2. Old rows keep decrypting (keyId → previous KEK, legacy '' → fallback).
--   3. Lazy re-encrypt on read (GET /api/v1/usage) + the `keys:reencrypt`
--      background pass re-wrap stale rows under the active KEK.
--   4. Drop the previous secret once no `key_id != <active>` rows remain.
--
-- Safety: the pre-migration table is snapshotted to
-- `user_opencode_keys_backup_0006` (one-time; IF NOT EXISTS keeps reruns
-- idempotent) and legacy rows backfill to 'v1', which decrypts with the
-- unchanged secret — reads never break mid-rotation.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_opencode_keys_backup_0006" AS TABLE "user_opencode_keys";
--> statement-breakpoint
ALTER TABLE "user_opencode_keys" ADD COLUMN IF NOT EXISTS "key_id" text NOT NULL DEFAULT 'v1';
