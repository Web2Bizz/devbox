import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppLogger } from '../common/app-logger.service';

export type TokenType = 'access' | 'refresh';

export type AccessClaims = {
  sub: string;
  email: string;
  typ: 'access';
  jti: string;
  iat: number;
  exp: number;
};

export type RefreshClaims = {
  sub: string;
  typ: 'refresh';
  jti: string;
  iat: number;
  exp: number;
};

/** Ephemeral dev fallback secrets (unset JWT_*_SECRET → WARN + random per boot). Never logged. */
const devSecrets = new Map<string, string>();

export function devJwtSecret(kind: 'access' | 'refresh'): string {
  let s = devSecrets.get(kind);
  if (!s) {
    s = randomBytes(48).toString('base64url');
    devSecrets.set(kind, s);
  }
  return s;
}

/** Test seam — drops the ephemeral dev secrets (fresh randomness next call). */
export function clearDevJwtSecretsForTests(): void {
  devSecrets.clear();
}

function b64urlEncode(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}

function b64urlDecodeToString(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/** Parses '15m' | '1h' | '7d' | '3600' (seconds) → seconds. NaN when invalid. */
export function parseTtlToSeconds(raw: string): number {
  const v = raw.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const m = /^(\d+)\s*([smhd])$/i.exec(v);
  if (!m) return NaN;
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
  return n * mult;
}

function signHs256(headerB64: string, payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`, 'utf8').digest('base64url');
}

const JWT_HEADER_B64 = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

/**
 * TokenService — hand-rolled HS256 JWT (node:crypto, zero npm deps; see
 * docs/auth-decision.md — no @nestjs/jwt / passport / jose).
 *
 * - signAccess/signRefresh embed jti + typ + exp.
 * - verifyAccess checks signature (timing-safe) + typ + exp; never throws.
 * - Refresh rotation store (in-memory, MVP like GithubInstallationsService):
 *   consumeRefresh() verifies, enforces single-use jti, rotates to a new pair.
 *   Reuse of a rotated jti revokes the whole family (401 on next use).
 */
@Injectable()
export class TokenService {
  /** refresh jti → userId (live family members only). */
  private readonly liveRefresh = new Map<string, string>();
  /** revoked refresh jtis (rotated or logged-out; reuse → family revoke + 401). */
  private readonly revokedRefresh = new Set<string>();

  constructor(private readonly logger: AppLogger = new AppLogger('TokenService')) {}

  sign(
    claims: Record<string, unknown>,
    secret: string,
    ttlSec: number,
  ): { token: string; jti: string; exp: number } {
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const payload = { ...claims, jti, iat: now, exp: now + ttlSec };
    const payloadB64 = b64urlEncode(JSON.stringify(payload));
    const sig = signHs256(JWT_HEADER_B64, payloadB64, secret);
    return { token: `${JWT_HEADER_B64}.${payloadB64}.${sig}`, jti, exp: now + ttlSec };
  }

  private verify(token: string, secret: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    if (h !== JWT_HEADER_B64) return null;
    let expected: Buffer;
    try {
      expected = Buffer.from(signHs256(h, p, secret), 'base64url');
    } catch {
      return null;
    }
    let actual: Buffer;
    try {
      actual = Buffer.from(s, 'base64url');
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(b64urlDecodeToString(p)) as Record<string, unknown>;
    } catch {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload['exp'] !== 'number' || (payload['exp'] as number) <= now) return null;
    return payload;
  }

  verifyAccess(token: string, secret: string): AccessClaims | null {
    const payload = this.verify(token, secret);
    if (!payload || payload['typ'] !== 'access') return null;
    if (typeof payload['sub'] !== 'string' || typeof payload['email'] !== 'string') return null;
    return payload as unknown as AccessClaims;
  }

  /** Issues a pair and tracks the refresh jti as live. */
  issuePair(
    user: { id: string; email: string },
    accessSecret: string,
    refreshSecret: string,
    accessTtlSec: number,
    refreshTtlSec: number,
    correlationId?: string,
  ): { accessToken: string; refreshToken: string; expiresIn: number } {
    const access = this.sign(
      { sub: user.id, email: user.email, typ: 'access' },
      accessSecret,
      accessTtlSec,
    );
    const refresh = this.sign({ sub: user.id, typ: 'refresh' }, refreshSecret, refreshTtlSec);
    this.liveRefresh.set(refresh.jti, user.id);
    // Hot path (every login/register/refresh) → debug, cid-bound, no tokens.
    this.logger.debug('[auth] token pair issued', correlationId);
    return { accessToken: access.token, refreshToken: refresh.token, expiresIn: accessTtlSec };
  }

  /**
   * Single-use refresh rotation. Returns a fresh pair or null (unknown /
   * revoked / reused jti → null; reuse revokes the family member set).
   * emailForSub may hit Postgres (UsersService) — hence async.
   */
  async consumeRefresh(
    token: string,
    refreshSecret: string,
    emailForSub: (userId: string) => string | null | Promise<string | null>,
    accessSecret: string,
    accessTtlSec: number,
    refreshTtlSec: number,
    correlationId?: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
    const payload = this.verify(token, refreshSecret);
    if (!payload || payload['typ'] !== 'refresh') return null;
    const jti = payload['jti'] as string;
    const sub = payload['sub'] as string;
    if (typeof jti !== 'string' || typeof sub !== 'string') return null;
    const owner = this.liveRefresh.get(jti);
    if (!owner || owner !== sub || this.revokedRefresh.has(jti)) {
      // Reuse / forgery attempt — revoke the presented family anchor.
      if (owner) {
        this.liveRefresh.delete(jti);
        this.revokedRefresh.add(jti);
        this.logger.warn('[auth] refresh reuse detected', correlationId);
      } else {
        this.logger.warn('[auth] refresh verify failed', correlationId);
      }
      return null;
    }
    const email = await emailForSub(sub);
    if (!email) {
      this.liveRefresh.delete(jti);
      this.revokedRefresh.add(jti);
      return null;
    }
    this.liveRefresh.delete(jti);
    this.revokedRefresh.add(jti);
    return this.issuePair({ id: sub, email }, accessSecret, refreshSecret, accessTtlSec, refreshTtlSec, correlationId);
  }

  /** Idempotent logout — revokes the presented refresh jti when live. */
  revokeRefresh(token: string, refreshSecret: string): boolean {
    const payload = this.verify(token, refreshSecret);
    if (!payload || payload['typ'] !== 'refresh') return false;
    const jti = payload['jti'] as string;
    if (typeof jti !== 'string') return false;
    const existed = this.liveRefresh.delete(jti);
    this.revokedRefresh.add(jti);
    return existed;
  }

  /** Test/e2e seam — drops rotation state. */
  clearAllForTests(): void {
    this.liveRefresh.clear();
    this.revokedRefresh.clear();
  }
}
