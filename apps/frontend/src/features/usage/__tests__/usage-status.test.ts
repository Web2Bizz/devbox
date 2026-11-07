/**
 * mapUsageStatus — unified usage error model (single source for Limits).
 * Null → ready; 404 missing-key / 401 invalid-key → user branches (no
 * error text); session 401 / dead session → session-expired; 429/5xx/0 →
 * failed upstream; any other failure → failed non-upstream with the raw
 * `code: message` confined to `diagnostic` + `shortId` (never UI text).
 */
import { describe, expect, test } from 'bun:test';
import { ApiClientError } from '../../../api/client';
import {
  SessionExpiredError,
  isMissingKeyError,
  isRejectedKeyError,
  isUpstreamDownError,
  mapUsageStatus,
} from '../usage-status';

const STRINGS = { sessionExpired: 'Session expired', unexpected: 'Unexpected error' };

function apiError(args: { code: string; message: string; status: number; correlationId: string }) {
  return new ApiClientError(args);
}

describe('mapUsageStatus', () => {
  test('nullish input is ready', () => {
    expect(mapUsageStatus(null, STRINGS)).toEqual({ kind: 'ready' });
    expect(mapUsageStatus(undefined, STRINGS)).toEqual({ kind: 'ready' });
  });

  test('404 opencode_key_missing → missing-key', () => {
    const err = apiError({
      code: 'opencode_key_missing',
      message: 'no stored key',
      status: 404,
      correlationId: 'corr-404',
    });
    expect(isMissingKeyError(err)).toBe(true);
    expect(mapUsageStatus(err, STRINGS)).toEqual({ kind: 'missing-key' });
  });

  test('401 opencode_key_invalid → invalid-key (never a refresh)', () => {
    const err = apiError({
      code: 'opencode_key_invalid',
      message: 'rejected upstream',
      status: 401,
      correlationId: 'corr-401k',
    });
    expect(isRejectedKeyError(err)).toBe(true);
    expect(mapUsageStatus(err, STRINGS)).toEqual({ kind: 'invalid-key' });
  });

  test('plain 401 → session-expired', () => {
    const err = apiError({
      code: 'unauthorized',
      message: 'Unauthorized',
      status: 401,
      correlationId: 'corr-401',
    });
    expect(isRejectedKeyError(err)).toBe(false);
    expect(mapUsageStatus(err, STRINGS)).toEqual({
      kind: 'session-expired',
      message: 'Session expired',
    });
  });

  test('dead session → session-expired', () => {
    expect(mapUsageStatus(new SessionExpiredError(), STRINGS)).toEqual({
      kind: 'session-expired',
      message: 'Session expired',
    });
  });

  test('503 / 429 / 0 → failed upstream with diagnostic + shortId', () => {
    for (const [status, code] of [
      [503, 'EXTERNAL_UNAVAILABLE'],
      [429, 'rate_limited'],
      [0, 'network_error'],
    ] as const) {
      const err = apiError({ code, message: 'down', status, correlationId: 'abcdef12-xyz' });
      expect(isUpstreamDownError(err)).toBe(true);
      const out = mapUsageStatus(err, STRINGS);
      expect(out).toEqual({
        kind: 'failed',
        message: 'Unexpected error',
        upstream: true,
        diagnostic: `${code}: down (ID: abcdef12)`,
        shortId: 'abcdef12',
      });
    }
  });

  test('generic 404 / 403 → failed non-upstream, code confined to diagnostic', () => {
    const err = apiError({
      code: 'forbidden',
      message: 'forbidden',
      status: 403,
      correlationId: 'corr-403-xyz',
    });
    expect(isUpstreamDownError(err)).toBe(false);
    const out = mapUsageStatus(err, STRINGS);
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.message).toBe('Unexpected error');
      expect(out.upstream).toBe(false);
      expect(out.diagnostic).toContain('forbidden');
      expect(out.shortId).toBe('corr-403');
      // UI text carries no raw code:message.
      expect(out.message).not.toContain('forbidden');
    }
  });

  test('plain Error → failed non-upstream without shortId', () => {
    const out = mapUsageStatus(new Error('boom'), STRINGS);
    expect(out).toEqual({
      kind: 'failed',
      message: 'Unexpected error',
      upstream: false,
      diagnostic: 'boom',
      shortId: '',
    });
  });
});
