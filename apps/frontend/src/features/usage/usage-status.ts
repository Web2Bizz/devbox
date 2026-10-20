'use client';

import { ApiClientError } from '../../api/client';
import { formatApiErrorWithId } from '../../lib/format-error';

export type UsageStrings = {
  sessionExpired: string;
  unexpected: string;
};

export type UsageStatus =
  | { kind: 'ready' }
  | { kind: 'missing-key' }
  | { kind: 'invalid-key' }
  | { kind: 'session-expired'; message: string }
  | {
      kind: 'failed';
      message: string;
      upstream: boolean;
      diagnostic: string;
      shortId: string;
    };

export class SessionExpiredError extends Error {
  constructor() {
    super('session-expired');
    this.name = 'SessionExpiredError';
  }
}

export function isMissingKeyError(e: unknown): boolean {
  return e instanceof ApiClientError && e.status === 404 && e.code === 'opencode_key_missing';
}

export function isRejectedKeyError(e: unknown): boolean {
  return e instanceof ApiClientError && e.status === 401 && e.code === 'opencode_key_invalid';
}

export function isUpstreamDownError(e: unknown): boolean {
  if (!(e instanceof ApiClientError)) return false;
  return e.status === 429 || e.status >= 500 || e.status === 0;
}

export function mapUsageStatus(error: unknown, strings: UsageStrings): UsageStatus {
  if (!error) return { kind: 'ready' };

  if (error instanceof SessionExpiredError) {
    return { kind: 'session-expired', message: strings.sessionExpired };
  }

  if (error instanceof ApiClientError) {
    if (isMissingKeyError(error)) return { kind: 'missing-key' };
    if (isRejectedKeyError(error)) return { kind: 'invalid-key' };
    if (error.status === 401) {
      return { kind: 'session-expired', message: strings.sessionExpired };
    }
    const detailed = formatApiErrorWithId(error);
    return {
      kind: 'failed',
      message: strings.unexpected,
      upstream: isUpstreamDownError(error),
      diagnostic: detailed.display,
      shortId: detailed.shortId,
    };
  }

  if (error instanceof Error) {
    return {
      kind: 'failed',
      message: strings.unexpected,
      upstream: false,
      diagnostic: error.message,
      shortId: '',
    };
  }

  return {
    kind: 'failed',
    message: strings.unexpected,
    upstream: false,
    diagnostic: strings.unexpected,
    shortId: '',
  };
}
