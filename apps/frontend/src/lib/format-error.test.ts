/**
 * formatApiErrorWithId — additive diagnostic display `code: message (ID: 8)`.
 * Envelope {code,message,correlationId} untouched; only display formatting.
 */
import { describe, expect, test } from 'bun:test';
import { ApiClientError } from '../api/client';
import { formatApiError, formatApiErrorWithId } from './format-error';

describe('formatApiErrorWithId', () => {
  test('renders code:message with 8-char short ID', () => {
    const err = new ApiClientError({
      code: 'email_taken',
      message: 'Email is already registered',
      status: 409,
      correlationId: '12345678-aaaa-bbbb-cccc-dddddddddddd',
    });
    const out = formatApiErrorWithId(err);
    expect(out.code).toBe('email_taken');
    expect(out.correlationId).toBe('12345678-aaaa-bbbb-cccc-dddddddddddd');
    expect(out.shortId).toBe('12345678');
    expect(out.display).toBe('email_taken: Email is already registered (ID: 12345678)');
  });

  test('keeps legacy formatApiError unchanged', () => {
    const err = new ApiClientError({
      code: 'timeout',
      message: 'Request timed out after 10000ms',
      status: 0,
      correlationId: 'deadbeef-1234',
    });
    expect(formatApiError(err)).toBe('timeout: Request timed out after 10000ms');
  });

  test('unknown errors stay generic without ID', () => {
    const out = formatApiErrorWithId(new Error('boom'));
    expect(out.display).toBe('boom');
    expect(out.shortId).toBe('');
  });
});
