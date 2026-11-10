import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed install-state helpers for the GitHub App install flow.
 *
 * The callback is a plain browser redirect, so the state parameter is the
 * only trusted proof that the installation was started by the current
 * session. The state is HMAC-SHA256 signed (base64url payload + signature)
 * and carries the caller's user id plus an expiry timestamp. Verification
 * is constant-time and never depends on server-side storage.
 */

/** Default lifetime of an install state (10 minutes). */
export const APP_STATE_TTL_MS: number = 10 * 60_000;

export type AppStatePayload = {
  userId: string;
  iat: number;
  exp: number;
};

export type AppStateVerification =
  | { ok: true; payload: AppStatePayload }
  | { ok: false; reason: 'invalid' | 'expired' };

export type AppStateSignOptions = {
  ttlMs?: number;
  nowMs?: number;
};

export type AppStateVerifyOptions = {
  nowMs?: number;
};

const STATE_DOMAIN: string = 'github-install-state.';

function encodePayload(payload: AppStatePayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function signSegment(segment: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${STATE_DOMAIN}${segment}`, 'utf8')
    .digest('base64url');
}

/** Signs a compact state for the given user id. */
export function signAppState(
  userId: string,
  secret: string,
  options: AppStateSignOptions = {},
): string {
  const nowMs: number = options.nowMs ?? Date.now();
  const ttlMs: number = options.ttlMs ?? APP_STATE_TTL_MS;
  const payload: AppStatePayload = { userId, iat: nowMs, exp: nowMs + ttlMs };
  const encoded: string = encodePayload(payload);
  return `${encoded}.${signSegment(encoded, secret)}`;
}

/**
 * Verifies signature, payload shape and expiry. Any malformed or tampered
 * state is reported as `invalid`; a correctly signed but stale state is
 * reported as `expired` so the caller can pick the same 400 response.
 */
export function verifyAppState(
  state: string | null | undefined,
  secret: string,
  options: AppStateVerifyOptions = {},
): AppStateVerification {
  if (typeof state !== 'string' || state.length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  if (secret.length === 0) return { ok: false, reason: 'invalid' };

  const parts: Array<string> = state.split('.');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  // Tuple destructuring of the split parts — explicit annotation cannot be expressed here.
  const [encoded, signature] = parts;
  const expected: Buffer = Buffer.from(signSegment(encoded, secret), 'utf8');
  const actual: Buffer = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return { ok: false, reason: 'invalid' };
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: 'invalid' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'invalid' };
  }
  const candidate: {
    userId?: unknown;
    iat?: unknown;
    exp?: unknown;
  } = parsed as {
    userId?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (typeof candidate.userId !== 'string' || candidate.userId.length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof candidate.iat !== 'number' || !Number.isInteger(candidate.iat)) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof candidate.exp !== 'number' || !Number.isInteger(candidate.exp)) {
    return { ok: false, reason: 'invalid' };
  }
  const nowMs: number = options.nowMs ?? Date.now();
  if (candidate.exp <= nowMs) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    payload: {
      userId: candidate.userId,
      iat: candidate.iat,
      exp: candidate.exp,
    },
  };
}
