import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AppLogger } from "../common/app-logger.service.js";
import { MIN_OPENCODE_KEYS_ENCRYPTION_KEY_LENGTH } from "../env.js";

/** AES-256-GCM params: 12-byte IV, 16-byte auth tag (both base64 at rest). */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypted per-user OpenCode API key (at-rest shape, never logged). */
export interface EncryptedOpencodeKey {
  /** base64(12-byte random IV) */
  iv: string;
  /** base64(ciphertext || 16-byte auth tag) */
  data: string;
}

/**
 * Resolves the 32-byte AES key from OPENCODE_KEYS_ENCRYPTION_KEY.
 * Fail-fast at USE time (never at boot — an unconfigured secret must not
 * break unrelated suites): missing/short secret → 500
 * `opencode_keys_unconfigured`. Reads process.env directly (not validateEnv)
 * so encryption never breaks on unrelated env validation failures; the
 * short-secret ERROR at boot stays covered by validateEnv itself. The raw
 * secret is never logged and never leaves this module except as key material.
 */
function resolveAesKey(): Buffer {
  const raw = (process.env.OPENCODE_KEYS_ENCRYPTION_KEY ?? "").trim();
  if (!raw || raw.length < MIN_OPENCODE_KEYS_ENCRYPTION_KEY_LENGTH) {
    throw new InternalServerErrorException({
      code: "opencode_keys_unconfigured",
      message: "OpenCode key storage is not configured",
    });
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

/**
 * CryptoService — AES-256-GCM envelope for per-user OpenCode API keys.
 *
 * - Key: SHA-256(OPENCODE_KEYS_ENCRYPTION_KEY) (any ≥32-char secret works;
 *   no re-encrypt/rotation in this iteration — one key per deploy).
 * - encrypt(): fresh random 12-byte IV per call (same plaintext encrypts
 *   differently every time); returns base64 { iv, data } for the
 *   user_opencode_keys row (iv / encrypted_key columns).
 * - decrypt(): throws 500 `opencode_key_unreadable` on wrong-key/auth-tag
 *   mismatch or malformed input (fixed message, no secret echo).
 * - Nothing secret-bearing is ever logged (fixed event names only).
 */
@Injectable()
export class CryptoService {
  constructor(private readonly logger: AppLogger = new AppLogger("CryptoService")) {}

  encrypt(plain: string): EncryptedOpencodeKey {
    const key = resolveAesKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString("base64"),
      data: Buffer.concat([ciphertext, tag]).toString("base64"),
    };
  }

  decrypt(input: { iv: string; data: string }): string {
    const key = resolveAesKey();
    try {
      const iv = Buffer.from(input.iv, "base64");
      const raw = Buffer.from(input.data, "base64");
      if (iv.length !== IV_BYTES || raw.length <= TAG_BYTES) {
        throw new Error("malformed envelope");
      }
      const tag = raw.subarray(raw.length - TAG_BYTES);
      const ciphertext = raw.subarray(0, raw.length - TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      // Fixed event only — never the envelope, the key, or the plaintext.
      this.logger.error("[crypto] decrypt failed code=opencode_key_unreadable");
      throw new InternalServerErrorException({
        code: "opencode_key_unreadable",
        message: "Stored OpenCode key cannot be decrypted",
      });
    }
  }
}
