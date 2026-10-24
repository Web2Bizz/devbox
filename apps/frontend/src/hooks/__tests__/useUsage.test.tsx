/**
 * useUsage — live quota/usage via GET /api/v1/usage (P2 migration).
 *
 * Covers: success (data lands, no skeleton flash), 401 session refresh
 * (one silent retry, then data), dead session (401 + spent refresh →
 * sessionExpired, no retry storm), 404 missing-key (noKeyMissing, error
 * null, no refresh, no retry), 401 invalid-key (noKeyInvalid, error null,
 * no refresh), 404/403 terminal shape (bounded retry, loading false,
 * error surfaces), 503/429 upstreamDown (error + upstreamDown, no fake
 * 0% bars), reload (invalidate refetches, no skeleton flash with
 * placeholderData).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

class FakeApiClientError extends Error {
  code: string;
  status: number;
  correlationId: string;
  constructor(args: { code: string; message: string; status: number; correlationId: string }) {
    super(args.message);
    this.name = 'ApiClientError';
    this.code = args.code;
    this.status = args.status;
    this.correlationId = args.correlationId;
  }
}

const USAGE = {
  updatedAt: '2026-10-19T00:00:00.000Z',
  rolling: { used: 42, limit: 100 },
  weekly: { used: 10, limit: 100 },
};

let usageImpl: () => Promise<typeof USAGE> = async () => ({ ...USAGE });
const getUsageMock = mock(() => usageImpl());

let tokenImpl: () => Promise<string | null> = async () => 'test-token';
let refreshImpl: () => Promise<string | null> = async () => 'test-token';
const getValidAccessTokenMock = mock(() => tokenImpl());
const refreshAccessTokenMock = mock(() => refreshImpl());

mock.module('../../api/client', () => ({
  ApiClientError: FakeApiClientError,
  api: { getUsage: getUsageMock },
}));

mock.module('../../lib/auth-store', () => ({
  getValidAccessToken: getValidAccessTokenMock,
  refreshAccessToken: refreshAccessTokenMock,
}));

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createElement, useState } = await import('react');
const { createQueryClient } = await import('../../lib/query-client');
const { useUsage } = await import('../useUsage');

function wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const c = createQueryClient();
    // The hook passes a function `retry` (one retry on transient failures),
    // which overrides the test default `retry: false`. Collapse the
    // production backoff so the single retry settles inside `settle()`.
    c.setDefaultOptions({ queries: { retryDelay: 0 } });
    return c;
  });
  return createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  getUsageMock.mockClear();
  getValidAccessTokenMock.mockClear();
  refreshAccessTokenMock.mockClear();
  usageImpl = async () => ({ ...USAGE });
  tokenImpl = async () => 'test-token';
  refreshImpl = async () => 'test-token';
});

async function settle(rounds = 6) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

describe('useUsage', () => {
  test('success: usage lands, no error, no skeleton flash', async () => {
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle();

    expect(getUsageMock).toHaveBeenCalledTimes(1);
    expect(getUsageMock).toHaveBeenCalledWith('test-token');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.usage).toMatchObject({ rolling: { used: 42, limit: 100 } });
    expect(result.current.noKey).toBe(false);
    expect(result.current.noKeyMissing).toBe(false);
    expect(result.current.noKeyInvalid).toBe(false);
    expect(result.current.upstreamDown).toBe(false);
    expect(result.current.upstreamUnavailable).toBe(false);
  });

  test('401 session: one silent refresh retry, then data', async () => {
    let calls = 0;
    usageImpl = async () => {
      calls += 1;
      if (calls === 1) {
        throw new FakeApiClientError({
          code: 'unauthorized',
          message: 'Unauthorized',
          status: 401,
          correlationId: 'corr-401',
        });
      }
      return { ...USAGE };
    };
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle();

    expect(refreshAccessTokenMock).toHaveBeenCalled();
    expect(getUsageMock).toHaveBeenCalledTimes(2);
    expect(result.current.usage).not.toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.noKeyInvalid).toBe(false);
  });

  test('dead session: 401 + spent refresh → sessionExpired, no retry storm', async () => {
    usageImpl = async () => {
      throw new FakeApiClientError({
        code: 'unauthorized',
        message: 'Unauthorized',
        status: 401,
        correlationId: 'corr-dead',
      });
    };
    refreshImpl = async () => null;
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle();

    // Single attempt — terminal session state never retries.
    expect(getUsageMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.usage).toBeNull();
    expect(result.current.error).toBe('Session expired — please sign in again.');
  });

  test('404 missing-key: noKeyMissing, error null, no refresh, no retry', async () => {
    usageImpl = async () => {
      throw new FakeApiClientError({
        code: 'opencode_key_missing',
        message: 'no stored key',
        status: 404,
        correlationId: 'corr-404',
      });
    };
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle();

    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(getUsageMock).toHaveBeenCalledTimes(1);
    expect(result.current.noKey).toBe(true);
    expect(result.current.noKeyMissing).toBe(true);
    expect(result.current.noKeyInvalid).toBe(false);
    expect(result.current.upstreamDown).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.usage).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  test('401 invalid-key: noKeyInvalid, error null, no refresh loop', async () => {
    usageImpl = async () => {
      throw new FakeApiClientError({
        code: 'opencode_key_invalid',
        message: 'stored key rejected upstream',
        status: 401,
        correlationId: 'corr-401k',
      });
    };
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle();

    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(getUsageMock).toHaveBeenCalledTimes(1);
    expect(result.current.noKey).toBe(true);
    expect(result.current.noKeyInvalid).toBe(true);
    expect(result.current.noKeyMissing).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.usage).toBeNull();
  });

  test('404 generic: bounded retry (no storm), unexpected + diagnostic', async () => {
    usageImpl = async () => {
      throw new FakeApiClientError({
        code: 'not_found',
        message: 'missing',
        status: 404,
        correlationId: 'corr-g404',
      });
    };
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle(8);

    // usageRetry only exempts the missing-key 404 — generic 404 gets at
    // most one retry, never an infinite storm.
    expect(getUsageMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.current.loading).toBe(false);
    // Raw `code: message` never reaches the UI — only unexpected + diagnostic.
    expect(result.current.error).toBe('Unexpected error');
    expect(result.current.diagnostic).toContain('not_found');
    expect(result.current.shortId).toBe('corr-g40');
    expect(result.current.noKeyMissing).toBe(false);
    expect(result.current.upstreamDown).toBe(false);
  });

  test('403 forbidden: bounded retry (no storm), unexpected + diagnostic', async () => {
    usageImpl = async () => {
      throw new FakeApiClientError({
        code: 'forbidden',
        message: 'forbidden',
        status: 403,
        correlationId: 'corr-403',
      });
    };
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle(8);

    expect(getUsageMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('Unexpected error');
    expect(result.current.diagnostic).toContain('forbidden');
    expect(result.current.shortId).toBe('corr-403');
    expect(result.current.usage).toBeNull();
  });

  test('503: upstreamDown with unexpected + diagnostic, usage nulled (no fake 0% bars)', async () => {
    usageImpl = async () => {
      throw new FakeApiClientError({
        code: 'EXTERNAL_UNAVAILABLE',
        message: 'upstream down',
        status: 503,
        correlationId: 'corr-503',
      });
    };
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle(8);

    expect(result.current.loading).toBe(false);
    expect(result.current.usage).toBeNull();
    expect(result.current.upstreamDown).toBe(true);
    expect(result.current.upstreamUnavailable).toBe(true);
    expect(result.current.error).toBe('Unexpected error');
    expect(result.current.diagnostic).toContain('EXTERNAL_UNAVAILABLE');
    expect(result.current.shortId).toBe('corr-503');
  });

  test('429: throttled counts as upstreamDown', async () => {
    usageImpl = async () => {
      throw new FakeApiClientError({
        code: 'rate_limited',
        message: 'too many requests',
        status: 429,
        correlationId: 'corr-429',
      });
    };
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle(8);

    expect(result.current.upstreamDown).toBe(true);
    expect(result.current.error).toBe('Unexpected error');
    expect(result.current.diagnostic).toContain('rate_limited');
    expect(result.current.usage).toBeNull();
  });

  test('reload: invalidate refetches without skeleton flash', async () => {
    const { result } = renderHook(() => useUsage(), { wrapper });
    await settle();
    expect(getUsageMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.reload();
    });
    // Background refetch keeps previous data — no skeleton flash.
    expect(result.current.loading).toBe(false);
    expect(result.current.usage).not.toBeNull();
    await settle();

    expect(getUsageMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });
});
