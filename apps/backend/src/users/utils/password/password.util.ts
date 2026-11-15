import { serializeCause, type AppLogger } from "@common/logger";

/** Minimal Bun.password shape (bun-native argon2id; no npm dependency). */
type BunPassword = {
  hash: (password: string, options?: Record<string, unknown>) => Promise<string>;
  verify: (password: string, hash: string) => Promise<boolean>;
};

/** Logger slice the util needs — the util owns no logger and no DI (CoC §7). */
export type PasswordLogger = Pick<AppLogger, "debug" | "error">;

/** bun runtime global — the only argon2id source (no npm fallback by design). */
function passwordApi(): BunPassword {
  const runtime: { password?: BunPassword } | undefined = (
    globalThis as unknown as { Bun?: { password?: BunPassword } }
  ).Bun;
  const api: BunPassword | undefined = runtime?.password;
  if (!api) {
    throw new Error(
      "[auth] Bun.password is unavailable — run the backend on bun >= 1.4 (see docs/auth-decision.md).",
    );
  }
  return api;
}

/** argon2id hash (bun defaults for memory/time costs). */
export async function hashPassword(
  password: string,
  logger?: PasswordLogger,
): Promise<string> {
  const passwordHash: string = await passwordApi().hash(password, {
    algorithm: "argon2id",
  });
  logger?.debug("[auth] password hashed");
  return passwordHash;
}

/**
 * Constant-shape boolean — the caller maps false to a generic 401 (no enumeration).
 * A driver failure is not a wrong password (that answers false without throwing):
 * it is logged as a fixed event, with the sanitized cause at debug level only —
 * never the password or the hash — and also answers false.
 */
export async function verifyPassword(
  password: string,
  hash: string,
  logger?: PasswordLogger,
  correlationId?: string,
): Promise<boolean> {
  try {
    return await passwordApi().verify(password, hash);
  } catch (error) {
    logger?.error("[auth] password verify failed", undefined, correlationId);
    logger?.debug(
      `[auth] password verify cause=${serializeCause(error)}`,
      correlationId,
    );
    return false;
  }
}
