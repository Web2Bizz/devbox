/**
 * useNpm — live status through GET /api/v1/registry/npm/status
 * via TanStack Query (P3 migration).
 *
 * Covers: success (status/up + url/scope → single up package),
 * 503 (EXTERNAL_UNAVAILABLE surfaces as error with retry, no mock rows),
 * reload (invalidate refetch).
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

let statusImpl: () => Promise<{ status: 'up'; url: string; scope: string }> = async () => ({
  status: 'up',
  url: 'https://npm.registry.web2bizz.team',
  scope: '@web2bizz',
});
const statusMock = mock(() => statusImpl());

mock.module('../../api/client', () => ({
  ApiClientError: FakeApiClientError,
  api: { getNpmStatus: statusMock },
}));

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createElement, useState } = await import('react');
const { createQueryClient } = await import('../../lib/query-client');
const { useNpm } = await import('../useNpm');

function wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  statusMock.mockClear();
  statusImpl = async () => ({
    status: 'up',
    url: 'https://npm.registry.web2bizz.team',
    scope: '@web2bizz',
  });
});

async function settle(rounds = 4) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

describe('useNpm', () => {
  test('200: live status lands on a single up package', async () => {
    const { result } = renderHook(() => useNpm(), { wrapper });
    await settle();

    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.packages.length).toBe(1);
    expect(result.current.packages[0]).toMatchObject({
      id: 'default',
      status: 'up',
      url: 'https://npm.registry.web2bizz.team',
      scope: '@web2bizz',
    });
    expect(result.current.isEmpty).toBe(false);
  });

  test('503: EXTERNAL_UNAVAILABLE surfaces as error, no mock rows', async () => {
    statusImpl = async () => {
      throw new FakeApiClientError({
        code: 'EXTERNAL_UNAVAILABLE',
        message: 'service temporarily unavailable',
        status: 503,
        correlationId: 'corr-1',
      });
    };
    const { result } = renderHook(() => useNpm(), { wrapper });
    await settle();

    expect(result.current.loading).toBe(false);
    expect(result.current.packages).toEqual([]);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('EXTERNAL_UNAVAILABLE');
    expect(result.current.isEmpty).toBe(false);
  });

  test('reload: invalidate refetches the status', async () => {
    statusImpl = async () => {
      throw new FakeApiClientError({
        code: 'EXTERNAL_UNAVAILABLE',
        message: 'service temporarily unavailable',
        status: 503,
        correlationId: 'corr-1',
      });
    };
    const { result } = renderHook(() => useNpm(), { wrapper });
    await settle();
    expect(result.current.error).not.toBeNull();
    expect(statusMock).toHaveBeenCalledTimes(1);

    statusImpl = async () => ({
      status: 'up',
      url: 'https://npm.registry.web2bizz.team',
      scope: '@web2bizz',
    });
    act(() => {
      result.current.reload();
    });
    await settle();

    expect(statusMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.packages[0].scope).toBe('@web2bizz');
  });

  test('404: bounded retry (no storm), error surfaces, loading false', async () => {
    statusImpl = async () => {
      throw new FakeApiClientError({
        code: 'not_found',
        message: 'not found',
        status: 404,
        correlationId: 'corr-404',
      });
    };
    const { result } = renderHook(() => useNpm(), { wrapper });
    await settle(8);

    // retry: 1 → at most 2 attempts, never a storm.
    expect(statusMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.packages).toEqual([]);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('not_found');
    expect(result.current.isEmpty).toBe(false);
  });

  test('403: bounded retry (no storm), error surfaces (forbidden)', async () => {
    statusImpl = async () => {
      throw new FakeApiClientError({
        code: 'forbidden',
        message: 'forbidden',
        status: 403,
        correlationId: 'corr-403',
      });
    };
    const { result } = renderHook(() => useNpm(), { wrapper });
    await settle(8);

    expect(statusMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('forbidden');
  });

  test('reload keeps data (no skeleton flash, background refetch)', async () => {
    const { result } = renderHook(() => useNpm(), { wrapper });
    await settle();
    expect(result.current.packages.length).toBe(1);
    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.reload();
    });
    // placeholderData keeps previous data — no skeleton flash.
    expect(result.current.loading).toBe(false);
    expect(result.current.packages.length).toBe(1);
    await settle();

    expect(statusMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });
});
