import { Injectable } from "@nestjs/common";
import { AppLogger, serializeCause } from "../../../common/logger";

/** Minimal Bun.password shape (bun-native argon2id; no npm dependency). */
type BunPassword = {
  hash: (password: string, options?: Record<string, unknown>) => Promise<string>;
  verify: (password: string, hash: string) => Promise<boolean>;
};

/** bun runtime global — the only argon2id source (no npm fallback by design). */
function passwordApi(): BunPassword {
  const runtime = (globalThis as unknown as { Bun?: { password?: BunPassword } })
    .Bun;
  const api = runtime?.password;
  if (!api) {
    throw new Error(
      "[auth] Bun.password is unavailable — run the backend on bun >= 1.4 (see docs/auth-decision.md).",
    );
  }
  return api;
}

/**
 * PasswordService — argon2id via bun-native `Bun.password` (see
 * docs/auth-decision.md: no @node-rs/argon2 / argon2 npm deps).
 * Hashes carry no secrets into logs — only fixed prefixes; a driver failure is
 * logged as a fixed event, with the sanitized cause only at debug level.
 */
@Injectable()
export class PasswordService {
  constructor(
    private readonly logger: AppLogger = new AppLogger("PasswordService"),
  ) {}

  /** argon2id hash (bun defaults for memory/time costs). */
  async hash(password: string): Promise<string> {
    const passwordHash = await passwordApi().hash(password, {
      algorithm: "argon2id",
    });
    this.logger.debug("[auth] password hashed");
    return passwordHash;
  }

  /** Constant-shape boolean — caller maps false to generic 401 (no enumeration). */
  async verify(
    password: string,
    hash: string,
    correlationId?: string,
  ): Promise<boolean> {
    try {
      return await passwordApi().verify(password, hash);
    } catch (error) {
      // Driver failure (a wrong password returns false, it does not throw):
      // fixed message at error level, sanitized cause only in debug — never the
      // password or the hash.
      this.logger.error("[auth] password verify failed", undefined, correlationId);
      this.logger.debug(
        `[auth] password verify cause=${serializeCause(error)}`,
        correlationId,
      );
      return false;
    }
  }
}
