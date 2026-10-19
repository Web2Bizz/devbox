/**
 * useProfile / useHeaderProfile — TanStack Query migration (P1).
 *
 * Covers: success (GET lands, no skeleton flash), header+page dedup (one
 * GET /auth/me for both observers on a shared client), update (PATCH +
 * setQueryData, no extra GET, saved flag), validation (blank name → false),
 * 401 refresh retry (one silent retry, then profile), dead session (401 +
 * spent refresh → sessionExpired, no react-query retry), reload (invalidate).
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

const ME_USER = {
  id: 'mock-user-1',
  firstName: 'Devbox',
  lastName: 'Developer',
  email: 'dev@devbox.local',
  provider: 'local' as const,
  createdAt: '2026-01-15T09:00:00.000Z',
};

let meImpl: () => Promise<typeof ME_USER> = async () => ({ ...ME_USER });
const meMock = mock(() => meImpl());
const updateMeMock = mock(async (_token: string, patch: { firstName?: string; lastName?: string }) => ({
  ...ME_USER,
  firstName: patch.firstName ?? ME_USER.firstName,
  lastName: patch.lastName ?? ME_USER.lastName,
}));

let tokenImpl: () => Promise<string | null> = async () => 'test-token';
let refreshImpl: () => Promise<string | null> = async () => 'test-token';
const getValidAccessTokenMock = mock(() => tokenImpl());
const refreshAccessTokenMock = mock(() => refreshImpl());

mock.module('../../api/client', () => ({
  ApiClientError: FakeApiClientError,
  api: { me: meMock, updateMe: updateMeMock },
}));

mock.module('../../lib/auth-store', () => ({
  getValidAccessToken: getValidAccessTokenMock,
  refreshAccessToken: refreshAccessTokenMock,
}));

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createElement, useState } = await import('react');
const { createQueryClient } = await import('../../lib/query-client');
const { useProfile, useHeaderProfile } = await import('../useProfile');

function wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  meMock.mockClear();
  updateMeMock.mockClear();
  getValidAccessTokenMock.mockClear();
  refreshAccessTokenMock.mockClear();
  meImpl = async () => ({ ...ME_USER });
  tokenImpl = async () => 'test-token';
  refreshImpl = async () => 'test-token';
});

async function settle(rounds = 4) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

describe('useProfile', () => {
  test('success: GET /auth/me lands as Profile, no error', async () => {
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle();

    expect(meMock).toHaveBeenCalledTimes(1);
    expect(meMock).toHaveBeenCalledWith('test-token');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.profile).toEqual({
      id: 'mock-user-1',
      name: 'Devbox Developer',
      email: 'dev@devbox.local',
      createdAt: '2026-01-15T09:00:00.000Z',
    });
    expect(result.current.saved).toBe(false);
    expect(result.current.saving).toBe(false);
  });

  test('dedup: header + page observers share one GET on a shared client', async () => {
    const client = createQueryClient();
    const shared = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    const page = renderHook(() => useProfile(), { wrapper: shared });
    const header = renderHook(() => useHeaderProfile(), { wrapper: shared });
    await settle();

    // Two observers, one cache entry, one network request.
    expect(meMock).toHaveBeenCalledTimes(1);
    expect(page.result.current.profile).toEqual(header.result.current.profile);
    expect(header.result.current.profile?.name).toBe('Devbox Developer');
    expect(header.result.current.loading).toBe(false);
    page.unmount();
    header.unmount();
  });

  test('update: PATCH + setQueryData (no extra GET), saved flag', async () => {
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle();
    expect(meMock).toHaveBeenCalledTimes(1);

    let ok = false;
    await act(async () => {
      ok = await result.current.update({ name: 'Jane Doe' });
    });
    await settle();

    expect(ok).toBe(true);
    expect(updateMeMock).toHaveBeenCalledTimes(1);
    expect(updateMeMock).toHaveBeenCalledWith('test-token', {
      firstName: 'Jane',
      lastName: 'Doe',
    });
    expect(result.current.profile?.name).toBe('Jane Doe');
    expect(result.current.saved).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
    // Cache patched directly — no background GET after update.
    expect(meMock).toHaveBeenCalledTimes(1);
  });

  test('validation: blank name → false, no PATCH', async () => {
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle();

    let ok = true;
    await act(async () => {
      ok = await result.current.update({ name: '   ' });
    });

    expect(ok).toBe(false);
    expect(updateMeMock).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Name must not be empty.');
    expect(result.current.saved).toBe(false);
  });

  test('401: one silent refresh retry, then profile', async () => {
    let calls = 0;
    meImpl = async () => {
      calls += 1;
      if (calls === 1) {
        throw new FakeApiClientError({
          code: 'unauthorized',
          message: 'Unauthorized',
          status: 401,
          correlationId: 'corr-1',
        });
      }
      return { ...ME_USER };
    };
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle();

    expect(refreshAccessTokenMock).toHaveBeenCalled();
    expect(meMock).toHaveBeenCalledTimes(2);
    expect(result.current.profile?.name).toBe('Devbox Developer');
    expect(result.current.error).toBeNull();
  });

  test('dead session: 401 + spent refresh → sessionExpired, no retry storm', async () => {
    meImpl = async () => {
      throw new FakeApiClientError({
        code: 'unauthorized',
        message: 'Unauthorized',
        status: 401,
        correlationId: 'corr-2',
      });
    };
    refreshImpl = async () => null;
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle();

    expect(meMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.profile).toBeNull();
    expect(result.current.error).toBe('Session expired — please sign in again.');
  });

  test('reload: invalidate refetches the profile', async () => {
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle();
    expect(meMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reload();
    });
    await settle();

    expect(meMock).toHaveBeenCalledTimes(2);
  });

  test('dismiss: clears mutation error locally, cache untouched', async () => {
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle();

    await act(async () => {
      await result.current.update({ name: '   ' });
    });
    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.saved).toBe(false);
    // No refetch on dismiss — cache entry stays, single initial GET.
    expect(meMock).toHaveBeenCalledTimes(1);
  });

  test('404: bounded retry (no storm), error surfaces, loading false', async () => {
    meImpl = async () => {
      throw new FakeApiClientError({
        code: 'not_found',
        message: 'not found',
        status: 404,
        correlationId: 'corr-404',
      });
    };
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle(8);

    // profileRetry allows at most one retry for non-terminal states.
    expect(meMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.profile).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('not_found');
  });

  test('403: bounded retry (no storm), error surfaces, loading false', async () => {
    meImpl = async () => {
      throw new FakeApiClientError({
        code: 'forbidden',
        message: 'forbidden',
        status: 403,
        correlationId: 'corr-403',
      });
    };
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle(8);

    expect(meMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.profile).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('forbidden');
  });

  test('reload keeps data (no skeleton flash, background refetch)', async () => {
    const { result } = renderHook(() => useProfile(), { wrapper });
    await settle();
    expect(result.current.profile?.name).toBe('Devbox Developer');
    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.reload();
    });
    // placeholderData keeps previous data — no skeleton flash.
    expect(result.current.loading).toBe(false);
    expect(result.current.profile?.name).toBe('Devbox Developer');
    await settle();

    expect(meMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });
});
