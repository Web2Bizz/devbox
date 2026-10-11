/**
 * useOrganizations — membership-scoped list + create (etalon: useProjects).
 *
 * Covers: success (list lands, no skeleton flash), create (setQueryData
 * prepend + invalidate refetch), 503 (surfaces as error, no mock rows),
 * reload (invalidate refetches).
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

const ORG_1 = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'acme',
  description: null,
  ownerId: null,
  isPrivate: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

let listImpl: () => Promise<typeof ORG_1[]> = async () => [ORG_1];
const listMock = mock(() => listImpl());
const createMock = mock(async (_token: string, input: { name: string }) => ({
  ...ORG_1,
  id: '22222222-2222-2222-2222-222222222222',
  name: input.name,
}));

mock.module('../../api/client', () => ({
  ApiClientError: FakeApiClientError,
  api: { listOrganizations: listMock, createOrganization: createMock },
}));

mock.module('../../lib/auth-store', () => ({
  getValidAccessToken: async () => 'test-token',
}));

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createElement, useState } = await import('react');
const { createQueryClient } = await import('../../lib/query-client');
const { useOrganizations } = await import('../useOrganizations');

function wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  listMock.mockClear();
  createMock.mockClear();
  listImpl = async () => [ORG_1];
});

async function settle(rounds = 4) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

describe('useOrganizations', () => {
  test('success: membership-scoped list lands without error', async () => {
    const { result } = renderHook(() => useOrganizations(), { wrapper });
    await settle();

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith('test-token');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.organizations).toEqual([ORG_1]);
    expect(result.current.isEmpty).toBe(false);
  });

  test('empty: zero orgs → isEmpty without error', async () => {
    listImpl = async () => [];
    const { result } = renderHook(() => useOrganizations(), { wrapper });
    await settle();

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isEmpty).toBe(true);
  });

  test('503: surfaces as error, no mock rows', async () => {
    listImpl = async () => {
      throw new FakeApiClientError({
        code: 'EXTERNAL_UNAVAILABLE',
        message: 'postgres unreachable',
        status: 503,
        correlationId: 'corr-1',
      });
    };
    const { result } = renderHook(() => useOrganizations(), { wrapper });
    await settle();

    expect(result.current.loading).toBe(false);
    expect(result.current.organizations).toEqual([]);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('EXTERNAL_UNAVAILABLE');
    expect(result.current.isEmpty).toBe(false);
  });

  test('create: setQueryData + invalidate (cache stays fresh)', async () => {
    const { result } = renderHook(() => useOrganizations(), { wrapper });
    await settle();
    expect(listMock).toHaveBeenCalledTimes(1);

    let created: unknown = null;
    await act(async () => {
      created = await result.current.createOrganization('new-org');
    });
    await settle();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith('test-token', { name: 'new-org' });
    expect(created).toMatchObject({ name: 'new-org' });
    // invalidate → background refetch keeps the list consistent
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  test('reload: invalidate refetches the list', async () => {
    const { result } = renderHook(() => useOrganizations(), { wrapper });
    await settle();
    expect(listMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reload();
    });
    await settle();

    expect(listMock).toHaveBeenCalledTimes(2);
  });
});
