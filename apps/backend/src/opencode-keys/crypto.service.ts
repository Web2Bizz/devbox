import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AppLogger } from "../common/app-logger.service";
import {
  DEFAULT_OPENCODE_KEYS_ACTIVE_KEY_ID,
  DEFAULT_OPENCODE_KEYS_PREVIOUS_KEY_ID,
  MIN_OPENCODE_KEYS_ENCRYPTION_KEY_LENGTH,
  OPENCODE_KEYS_KEY_ID_PATTERN,
} from "../env";

/** AES-256-GCM params: 12-byte IV, 16-byte auth tag (both base64 at rest). */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypted per-user OpenCode API key (at-rest shape, never logged).
 *
 * - `keyId` selects the KEK version that wrapped the row (the `OPENCODE_KEYS_*`
 *   keyring, see below). Legacy rows written before key versioning carry no
 *   id (`undefined`/empty) and decrypt via the dual-read fallback.
 * - `iv` is base64(12-byte random IV), `data` is base64(ciphertext || tag).
 */
export type EncryptedOpencodeKey = {
  /** KEK version id (e.g. "v1"); never a secret, stored in plaintext. */
  keyId: string;
  /** base64(12-byte random IV) */
  iv: string;
  /** base64(ciphertext || 16-byte auth tag) */
  data: string;
};

/** Decrypt input — `keyId` is optional so pre-versioning rows stay readable. */
export type EncryptedOpencodeKeyInput = {
  /** KEK version id, or missing/empty for legacy rows. */
  keyId?: string | null;
  /** base64(12-byte random IV) */
  iv: string;
  /** base64(ciphertext || 16-byte auth tag) */
  data: string;
};

type KeyEntry = {
  id: string;
  key: Buffer;
};

type Keyring = {
  active: KeyEntry;
  previous?: KeyEntry;
};

function unconfigured(): InternalServerErrorException {
  return new InternalServerErrorException({
    code: "opencode_keys_unconfigured",
    message: "OpenCode key storage is not configured",
  });
}

/**
 * Reads the active KEK id (`OPENCODE_KEYS_ACTIVE_KEY_ID`, default "v1").
 * Explicit-but-malformed ids fail closed (same 500, fixed message).
 */
function resolveKeyId(raw: string | undefined, fallback: string): string {
  const id = (raw ?? "").trim() || fallback;
  if (!OPENCODE_KEYS_KEY_ID_PATTERN.test(id)) throw unconfigured();
  return id;
}

/** SHA-256 key material from a ≥32-char secret (never echoed, never logged). */
function materialize(secret: string): Buffer {
  if (!secret || secret.length < MIN_OPENCODE_KEYS_ENCRYPTION_KEY_LENGTH) {
    throw unconfigured();
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Resolves the versioned KEK keyring from env at USE time (never at boot —
 * an unconfigured secret must not break unrelated suites).
 *
 * - Active: `OPENCODE_KEYS_ENCRYPTION_KEY` (+ `OPENCODE_KEYS_ACTIVE_KEY_ID`).
 * - Previous (rotation window only): `OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS`
 *   (+ `OPENCODE_KEYS_PREVIOUS_KEY_ID`). Set-but-short fails closed.
 *
 * Reads process.env directly (not validateEnv) so encryption never breaks
 * on unrelated env validation failures. The raw secrets never leave this
 * module except as key material.
 */
function resolveKeyring(): Keyring {
  const activeSecret = (process.env.OPENCODE_KEYS_ENCRYPTION_KEY ?? "").trim();
  const active: KeyEntry = {
    id: resolveKeyId(
      process.env.OPENCODE_KEYS_ACTIVE_KEY_ID,
      DEFAULT_OPENCODE_KEYS_ACTIVE_KEY_ID,
    ),
    key: materialize(activeSecret),
  };
  const previousSecret = (
    process.env.OPENCODE_KEYS_ENCRYPTION_KEY_PREVIOUS ?? ""
  ).trim();
  if (!previousSecret) return { active };
  const previous: KeyEntry = {
    id: resolveKeyId(
      process.env.OPENCODE_KEYS_PREVIOUS_KEY_ID,
      DEFAULT_OPENCODE_KEYS_PREVIOUS_KEY_ID,
    ),
    key: materialize(previousSecret),
  };
  // Same id on both sides is a no-op (single effective key, no dual-read).
  if (previous.id === active.id) return { active };
  return { active, previous };
}

function decryptWith(
  entry: KeyEntry,
  iv: Buffer,
  raw: Buffer,
): string {
  if (iv.length !== IV_BYTES || raw.length <= TAG_BYTES) {
    throw new Error("malformed envelope");
  }
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(0, raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", entry.key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * CryptoService — AES-256-GCM envelope for per-user OpenCode API keys with
 * versioned KEK rotation.
 *
 * - Keyring: active KEK (`OPENCODE_KEYS_ENCRYPTION_KEY`, id from
 *   `OPENCODE_KEYS_ACTIVE_KEY_ID`, default "v1") + optional previous KEK
 *   (rotation window). KEK material is SHA-256(secret); secrets live only in
 *   env/KMS, never next to the ciphertext, never logged.
 * - encrypt(): fresh random 12-byte IV per call under the ACTIVE key;
 *   returns { keyId, iv, data } for the row (key_id / iv / encrypted_key).
 * - decrypt(): dual-read — tries the envelope's keyId first, then the other
 *   known KEK; legacy envelopes without keyId try active → previous. Throws
 *   500 `opencode_key_unreadable` when no KEK opens the envelope (wrong key /
 *   tamper / malformed — fixed message, no secret echo).
 * - Rotation (no downtime): deploy new secret as active + old as previous →
 *   old rows keep decrypting (dual-read) → lazy re-encrypt on read + the
 *   `keys:reencrypt` background pass re-wraps stale rows → drop previous.
 * - Nothing secret-bearing is ever logged (fixed event names only).
 */
@Injectable()
export class CryptoService {
  constructor(private readonly logger: AppLogger = new AppLogger("CryptoService")) {}

  /** Active KEK id new rows are wrapped with (fail-closed when unconfigured). */
  activeKeyId(): string {
    return resolveKeyring().active.id;
  }

  /** True when the row already uses the active KEK (no re-encrypt needed). */
  isActiveKeyId(keyId: string | null | undefined): boolean {
    if (!keyId) return false;
    try {
      return keyId === resolveKeyring().active.id;
    } catch {
      // Unconfigured storage fails closed downstream — never report "fresh".
      return false;
    }
  }

  encrypt(plain: string): EncryptedOpencodeKey {
    const { active } = resolveKeyring();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", active.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      keyId: active.id,
      iv: iv.toString("base64"),
      data: Buffer.concat([ciphertext, tag]).toString("base64"),
    };
  }

  decrypt(input: EncryptedOpencodeKeyInput): string {
    const ring = resolveKeyring();
    let iv: Buffer;
    let raw: Buffer;
    try {
      iv = Buffer.from(input.iv, "base64");
      raw = Buffer.from(input.data, "base64");
    } catch {
      this.logger.error("[crypto] decrypt failed code=opencode_key_unreadable");
      throw new InternalServerErrorException({
        code: "opencode_key_unreadable",
        message: "Stored OpenCode key cannot be decrypted",
      });
    }
    // Candidate order: envelope's KEK first, then the other known KEK
    // (dual-read across the rotation window); legacy envelopes without an
    // id try active → previous.
    const ordered: KeyEntry[] =
      input.keyId && input.keyId === ring.previous?.id
        ? [ring.previous, ring.active]
        : ring.previous
          ? [ring.active, ring.previous]
          : [ring.active];
    for (const entry of ordered) {
      try {
        return decryptWith(entry, iv, raw);
      } catch {
        // try the next KEK — report only when none opens the envelope.
      }
    }
    // Fixed event only — never the envelope, the key, or the plaintext.
    this.logger.error("[crypto] decrypt failed code=opencode_key_unreadable");
    throw new InternalServerErrorException({
      code: "opencode_key_unreadable",
      message: "Stored OpenCode key cannot be decrypted",
    });
  }
}
