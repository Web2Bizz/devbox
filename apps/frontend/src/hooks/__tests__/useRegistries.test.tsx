/**
 * useRegistries — live catalog through GET /api/v1/registry/catalog
 * via TanStack Query (P3 migration).
 *
 * Covers: success (repositories → single up registry), empty catalog
 * (registry with zero repos), 503 (EXTERNAL_UNAVAILABLE surfaces as
 * error with retry, no mock payloads), reload (invalidate refetch).
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

let catalogImpl: () => Promise<{ repositories: string[] }> = async () => ({
  repositories: ['library/nginx', 'team/app'],
});
const catalogMock = mock(() => catalogImpl());

mock.module('../../api/client', () => ({
  ApiClientError: FakeApiClientError,
  api: { getRegistryCatalog: catalogMock },
}));

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createElement, useState } = await import('react');
const { createQueryClient } = await import('../../lib/query-client');
const { useRegistries } = await import('../useRegistries');

function wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  catalogMock.mockClear();
  catalogImpl = async () => ({ repositories: ['library/nginx', 'team/app'] });
});

async function settle(rounds = 4) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

describe('useRegistries', () => {
  test('success: live repositories land on a single up registry', async () => {
    const { result } = renderHook(() => useRegistries(), { wrapper });
    await settle();

    expect(catalogMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.registries.length).toBe(1);
    expect(result.current.registries[0]).toMatchObject({
      id: 'default',
      status: 'up',
      repositories: ['library/nginx', 'team/app'],
    });
    expect(result.current.isEmpty).toBe(false);
  });

  test('empty: catalog without repos keeps the registry with zero repos', async () => {
    catalogImpl = async () => ({ repositories: [] });
    const { result } = renderHook(() => useRegistries(), { wrapper });
    await settle();

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.registries.length).toBe(1);
    expect(result.current.registries[0].repositories).toEqual([]);
    expect(result.current.isEmpty).toBe(false);
  });

  test('503: EXTERNAL_UNAVAILABLE surfaces as error with retry, no mock rows', async () => {
    catalogImpl = async () => {
      throw new FakeApiClientError({
        code: 'EXTERNAL_UNAVAILABLE',
        message: 'registry unreachable',
        status: 503,
        correlationId: 'corr-1',
      });
    };
    const { result } = renderHook(() => useRegistries(), { wrapper });
    await settle();

    expect(result.current.loading).toBe(false);
    expect(result.current.registries).toEqual([]);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('EXTERNAL_UNAVAILABLE');
    expect(result.current.isEmpty).toBe(false);
  });

  test('reload: invalidate refetches the catalog', async () => {
    catalogImpl = async () => {
      throw new FakeApiClientError({
        code: 'EXTERNAL_UNAVAILABLE',
        message: 'registry unreachable',
        status: 503,
        correlationId: 'corr-1',
      });
    };
    const { result } = renderHook(() => useRegistries(), { wrapper });
    await settle();
    expect(result.current.error).not.toBeNull();
    expect(catalogMock).toHaveBeenCalledTimes(1);

    catalogImpl = async () => ({ repositories: ['library/redis'] });
    act(() => {
      result.current.reload();
    });
    await settle();

    expect(catalogMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.registries[0].repositories).toEqual(['library/redis']);
  });

  test('404: bounded retry (no storm), error surfaces, loading false', async () => {
    catalogImpl = async () => {
      throw new FakeApiClientError({
        code: 'not_found',
        message: 'not found',
        status: 404,
        correlationId: 'corr-404',
      });
    };
    const { result } = renderHook(() => useRegistries(), { wrapper });
    await settle(8);

    // retry: 1 → at most 2 attempts, never a storm.
    expect(catalogMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.registries).toEqual([]);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('not_found');
    expect(result.current.isEmpty).toBe(false);
  });

  test('403: bounded retry (no storm), error surfaces (forbidden)', async () => {
    catalogImpl = async () => {
      throw new FakeApiClientError({
        code: 'forbidden',
        message: 'forbidden',
        status: 403,
        correlationId: 'corr-403',
      });
    };
    const { result } = renderHook(() => useRegistries(), { wrapper });
    await settle(8);

    expect(catalogMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('forbidden');
  });

  test('reload keeps data (no skeleton flash, background refetch)', async () => {
    const { result } = renderHook(() => useRegistries(), { wrapper });
    await settle();
    expect(result.current.registries.length).toBe(1);
    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.reload();
    });
    // placeholderData keeps previous data — no skeleton flash.
    expect(result.current.loading).toBe(false);
    expect(result.current.registries.length).toBe(1);
    await settle();

    expect(catalogMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });
});
