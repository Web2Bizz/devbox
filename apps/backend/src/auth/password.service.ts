import { Injectable } from '@nestjs/common';
import { AppLogger } from '../common/app-logger.service.js';

/** Minimal Bun.password shape (bun-native argon2id; no npm dependency). */
interface BunPassword {
  hash: (password: string, options?: Record<string, unknown>) => Promise<string>;
  verify: (password: string, hash: string) => Promise<boolean>;
}

function bunPassword(): BunPassword {
  const bun = (globalThis as unknown as { Bun?: { password?: BunPassword } }).Bun;
  const pw = bun?.password;
  if (!pw) {
    throw new Error(
      '[auth] Bun.password is unavailable — run the backend on bun >= 1.4 (see docs/auth-decision.md).',
    );
  }
  return pw;
}

/**
 * PasswordService — argon2id via bun-native `Bun.password` (see
 * docs/auth-decision.md: no @node-rs/argon2 / argon2 npm deps).
 * Hashes carry no secrets into logs — only fixed prefixes.
 */
@Injectable()
export class PasswordService {
  constructor(private readonly logger: AppLogger = new AppLogger('PasswordService')) {}

  /** argon2id hash (bun defaults for memory/time costs). */
  async hash(password: string): Promise<string> {
    const hash = await bunPassword().hash(password, { algorithm: 'argon2id' });
    this.logger.debug('[auth] password hashed');
    return hash;
  }

  /** Constant-shape boolean — caller maps false to generic 401 (no enumeration). */
  async verify(password: string, hash: string, correlationId?: string): Promise<boolean> {
    try {
      return await bunPassword().verify(password, hash);
    } catch (err) {
      // Driver failure (not a wrong password — that returns false): error
      // with sanitized stack, cid-bound, never the password/hash.
      this.logger.error(
        `[auth] password verify failure: ${(err as Error).message}`,
        (err as Error).stack,
        correlationId,
      );
      return false;
    }
  }
}
