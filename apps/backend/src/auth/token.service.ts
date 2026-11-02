import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DbService, dbUnavailable, type DbClient } from '../common/db/db.service';
import { refreshTokens } from '../common/db/schema';
import { AppLogger } from '../common/logger';

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

/** Wire pair handed back to the auth layer. */
type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };

/** The `refresh_tokens` row that backs a freshly signed refresh JWT. */
type RefreshRowSeed = { id: string; userId: string; issuedAt: Date; expiresAt: Date };

/** Ephemeral dev fallback secrets (unset JWT_*_SECRET → WARN + random per boot). Never logged. */
const devSecrets = new Map<string, string>();

export function devJwtSecret(kind: 'access' | 'refresh'): string {
  let secret = devSecrets.get(kind);
  if (!secret) {
    secret = randomBytes(48).toString('base64url');
    devSecrets.set(kind, secret);
  }
  return secret;
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

/** TTL unit suffixes accepted by parseTtlToSeconds. */
const TTL_UNIT_SECONDS: Record<'s' | 'm' | 'h' | 'd', number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Parses '15m' | '1h' | '7d' | '3600' (seconds) → seconds. NaN when invalid. */
export function parseTtlToSeconds(raw: string): number {
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(\d+)\s*([smhd])$/i.exec(value);
  if (!match) return NaN;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase() as 's' | 'm' | 'h' | 'd';
  return amount * TTL_UNIT_SECONDS[unit];
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
 * - Refresh rotation store is Postgres-backed (`refresh_tokens`):
 *   issuePair() inserts the jti row, consumeRefresh() enforces single-use by
 *   claiming the old jti in one conditional UPDATE (revoked_at IS NULL) and
 *   inserting the new pair in the same transaction. Concurrent consumers of
 *   the same jti cannot both win; reuse of a claimed jti revokes every live
 *   member of the user's family (401 on next use). No scenario runs a physical
 *   DELETE — revocation/prune are timestamp marks.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly db: DbService,
    private readonly logger: AppLogger = new AppLogger(TokenService.name),
  ) {}

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
    const [headerB64, payloadB64, signatureB64] = parts;
    if (headerB64 !== JWT_HEADER_B64) return null;
    let expected: Buffer;
    try {
      expected = Buffer.from(signHs256(headerB64, payloadB64, secret), 'base64url');
    } catch {
      return null;
    }
    let actual: Buffer;
    try {
      actual = Buffer.from(signatureB64, 'base64url');
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(b64urlDecodeToString(payloadB64)) as Record<string, unknown>;
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

  /** Runs one Postgres operation, mapping failures to 503 EXTERNAL_UNAVAILABLE. */
  private async dbCall<T>(
    operation: string,
    run: (client: DbClient) => Promise<T>,
    correlationId?: string,
  ): Promise<T> {
    try {
      return await run(this.db.client);
    } catch (err) {
      dbUnavailable(`token.${operation}`, err, this.logger, correlationId);
    }
  }

  /** Signs an access/refresh pair plus the `refresh_tokens` row that backs it (no I/O). */
  private signPair(
    user: { id: string; email: string },
    accessSecret: string,
    refreshSecret: string,
    accessTtlSec: number,
    refreshTtlSec: number,
  ): { pair: TokenPair; refreshRow: RefreshRowSeed } {
    const access = this.sign(
      { sub: user.id, email: user.email, typ: 'access' },
      accessSecret,
      accessTtlSec,
    );
    const refresh = this.sign({ sub: user.id, typ: 'refresh' }, refreshSecret, refreshTtlSec);
    return {
      pair: {
        accessToken: access.token,
        refreshToken: refresh.token,
        expiresIn: accessTtlSec,
      },
      refreshRow: {
        id: refresh.jti,
        userId: user.id,
        issuedAt: new Date((refresh.exp - refreshTtlSec) * 1000),
        expiresAt: new Date(refresh.exp * 1000),
      },
    };
  }

  /** Issues a pair and persists the refresh jti in `refresh_tokens`. */
  async issuePair(
    user: { id: string; email: string },
    accessSecret: string,
    refreshSecret: string,
    accessTtlSec: number,
    refreshTtlSec: number,
    correlationId?: string,
  ): Promise<TokenPair> {
    const { pair, refreshRow } = this.signPair(
      user,
      accessSecret,
      refreshSecret,
      accessTtlSec,
      refreshTtlSec,
    );
    await this.dbCall(
      'issuePair',
      async (db) => {
        await db.insert(refreshTokens).values(refreshRow);
      },
      correlationId,
    );
    // Hot path (every login/register/refresh) → debug, cid-bound, no tokens.
    this.logger.debug('[auth] token pair issued', correlationId);
    return pair;
  }

  /**
   * Single-use refresh rotation. Returns a fresh pair or null (unknown /
   * revoked / expired / reused jti → null; reuse revokes the live family).
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
  ): Promise<TokenPair | null> {
    const payload = this.verify(token, refreshSecret);
    if (!payload || payload['typ'] !== 'refresh') return null;
    const jti = payload['jti'];
    const sub = payload['sub'];
    if (typeof jti !== 'string' || typeof sub !== 'string') return null;

    // Read-only projection first: the rotation transaction below stays free of
    // external awaits, and a missing user never burns a still-valid jti.
    const email = await emailForSub(sub);
    if (!email) {
      await this.revokeJti(jti, correlationId);
      return null;
    }

    // One conditional UPDATE is the claim: concurrent consumers of the same jti
    // all run it, but only the one that flips revoked_at away from NULL matches
    // a row. The new jti is inserted in the same transaction, so a failed insert
    // rolls the claim back instead of burning a live refresh token.
    const rotated = await this.dbCall(
      'consumeRefresh',
      async (db) =>
        db.transaction(async (transaction) => {
          const claimed = await transaction
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(refreshTokens.id, jti),
                eq(refreshTokens.userId, sub),
                isNull(refreshTokens.revokedAt),
                isNull(refreshTokens.deletedAt),
                gt(refreshTokens.expiresAt, new Date()),
              ),
            )
            .returning({ id: refreshTokens.id });
          if (claimed.length !== 1) return null;
          const { pair, refreshRow } = this.signPair(
            { id: sub, email },
            accessSecret,
            refreshSecret,
            accessTtlSec,
            refreshTtlSec,
          );
          await transaction.insert(refreshTokens).values(refreshRow);
          return pair;
        }),
      correlationId,
    );
    if (rotated) {
      this.logger.debug('[auth] token pair issued', correlationId);
      return rotated;
    }

    // Lost the claim: one diagnostic read tells reuse apart from a dead row.
    const row = await this.dbCall(
      'consumeRefresh.select',
      async (db) => {
        const found = await db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, jti))
          .limit(1);
        return found[0] ?? null;
      },
      correlationId,
    );
    if (row && row.userId === sub && row.revokedAt) {
      // Reuse of a consumed/logged-out jti — revoke every live family member.
      await this.revokeAll(row.userId, correlationId);
      this.logger.warn('[auth] refresh reuse detected', correlationId);
      return null;
    }
    this.logger.warn('[auth] refresh verify failed', correlationId);
    return null;
  }

  /** Idempotent logout — marks the presented refresh jti revoked. */
  async revokeRefresh(token: string, refreshSecret: string): Promise<boolean> {
    const payload = this.verify(token, refreshSecret);
    if (!payload || payload['typ'] !== 'refresh') return false;
    const jti = payload['jti'];
    if (typeof jti !== 'string') return false;
    const updated = await this.dbCall('revokeRefresh', (db) =>
      db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.id, jti), isNull(refreshTokens.revokedAt)))
        .returning(),
    );
    return updated.length > 0;
  }

  /** Marks every live token of the user revoked (never deletes rows). */
  async revokeAll(userId: string, correlationId?: string): Promise<void> {
    await this.dbCall(
      'revokeAll',
      async (db) => {
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(refreshTokens.userId, userId),
              isNull(refreshTokens.revokedAt),
              isNull(refreshTokens.deletedAt),
            ),
          );
      },
      correlationId,
    );
  }

  /** Soft-prune — marks `deleted_at` on expired rows that are still live. */
  async pruneExpired(): Promise<void> {
    await this.dbCall('pruneExpired', async (db) => {
      await db
        .update(refreshTokens)
        .set({ deletedAt: new Date() })
        .where(and(lt(refreshTokens.expiresAt, new Date()), isNull(refreshTokens.deletedAt)));
    });
  }

  private async revokeJti(jti: string, correlationId?: string): Promise<void> {
    await this.dbCall(
      'revokeRefresh',
      async (db) => {
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.id, jti), isNull(refreshTokens.revokedAt)))
          .returning();
      },
      correlationId,
    );
  }

  /** Test/e2e seam — soft-deletes every refresh row (never a physical DELETE). */
  async clearAllForTests(): Promise<void> {
    await this.dbCall('clearAllForTests', async (db) => {
      const now = new Date();
      await db
        .update(refreshTokens)
        .set({ revokedAt: now, deletedAt: now })
        .where(isNull(refreshTokens.deletedAt));
    });
  }
}
