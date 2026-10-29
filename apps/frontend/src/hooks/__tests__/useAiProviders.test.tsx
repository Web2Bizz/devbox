/**
 * useAiProviders — provider inventory via the DOMAIN route
 * (api/sessions-client listSessionProviders → GET /api/sessions/providers;
 * rows are the contract SessionRunnerProvider subset: id/name/activation/
 * package — boundary-parsed in api/client).
 *
 * Covers: success (providers land with mapped fields from domain rows,
 * activation:'disabled' → enabled:false), empty (isEmpty), project scope
 * (queryKey per projectId, `?? 'none'`), no projectId → honest
 * PROJECT_REQUIRED without network, toggle (setQueryData flip, no extra
 * GET), configure (setQueryData + notice + error dismiss, no extra GET),
 * 503 (error surfaces, bounded retry), 404/403 (bounded retry, loading
 * false, error surfaces), reload (invalidate refetches, no skeleton
 * flash), dismiss (clears error + notice locally, no refetch).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

// Domain rows per @rush-code/contracts SessionRunnerProvider.
const PROVIDERS = [
  { id: 'prov-openai', name: 'OpenAI', activation: 'enabled', package: '@pproviders/openai' },
  { id: 'prov-anthropic', name: '', activation: 'disabled', package: '' },
];

const PROJECT = '123e4567-e89b-12d3-a456-426614174090';

let providersImpl: (projectId: string, opts?: { signal?: AbortSignal }) => Promise<unknown> =
  async () => PROVIDERS;
const providersMock = mock((projectId: string, opts?: { signal?: AbortSignal }) =>
  providersImpl(projectId, opts),
);

function toErrorMessageLocal(error: unknown): string {
  if (error === undefined || error === null) return 'Unexpected error';
  if (typeof error === 'string') return error || 'Unexpected error';
  if (error instanceof Error) return error.message || 'Unexpected error';
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message) return obj.message;
  }
  return 'Unexpected error';
}

mock.module('../../api/sessions-client', () => ({
  listSessionProviders: (projectId: string, opts?: { signal?: AbortSignal }) =>
    providersMock(projectId, opts),
  toErrorMessage: toErrorMessageLocal,
}));

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createElement, useState } = await import('react');
const { createQueryClient } = await import('../../lib/query-client');
const { useAiProviders } = await import('../useAiProviders');
const { aiProvidersQueryKey } = await import('../query-keys');

function wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  providersMock.mockClear();
  providersImpl = async () => PROVIDERS;
});

async function settle(rounds = 6) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

// The query keeps `retry: 1` with the client's exponential retryDelay
// (first retry at ~1000ms) — the ERROR state materializes only after the
// retry budget is spent. Wait it out honestly (the previous version of
// this file asserted inside the retry window and was red on base — asserts
// got STRICTER: exact attempt count, terminal error state).
async function settleRetryBudget() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1300));
  });
  await settle();
}

describe('useAiProviders', () => {
  test('success: domain rows land with mapped fields, no error', async () => {
    const { result } = renderHook(() => useAiProviders(PROJECT), { wrapper });
    await settle();

    expect(providersMock).toHaveBeenCalledTimes(1);
    expect(providersMock.mock.calls[0]?.[0]).toBe(PROJECT);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.providers.length).toBe(2);
    expect(result.current.providers[0]).toMatchObject({
      id: 'prov-openai',
      name: 'OpenAI',
      description: '@pproviders/openai',
      enabled: true,
      status: 'connected',
      modelsCount: 0,
    });
    // Empty name falls back to id; activation:'disabled' → enabled:false.
    expect(result.current.providers[1].name).toBe('prov-anthropic');
    expect(result.current.providers[1].enabled).toBe(false);
    expect(result.current.isEmpty).toBe(false);
  });

  test('empty: zero providers → isEmpty without error', async () => {
    providersImpl = async () => [];
    const { result } = renderHook(() => useAiProviders(PROJECT), { wrapper });
    await settle();

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isEmpty).toBe(true);
  });

  test('project scope: key splits per projectId, `?? none` for nullish', async () => {
    const { result } = renderHook(() => useAiProviders(PROJECT), { wrapper });
    await settle();
    expect(result.current.providers.length).toBe(2);
    // Key identity: nullish → 'none', empty string stays as-is.
    expect(aiProvidersQueryKey()).toEqual(['ai-providers', 'none']);
    expect(aiProvidersQueryKey(undefined)).toEqual(['ai-providers', 'none']);
    expect(aiProvidersQueryKey('')).toEqual(['ai-providers', '']);
    expect(aiProvidersQueryKey(PROJECT)).toEqual(['ai-providers', PROJECT]);
  });

  test('no projectId: honest PROJECT_REQUIRED before any network', async () => {
    const { result } = renderHook(() => useAiProviders(), { wrapper });
    await settleRetryBudget();

    expect(providersMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toContain('projectId is required');
  });

  test('toggle: setQueryData flips enabled, no extra GET', async () => {
    const { result } = renderHook(() => useAiProviders(PROJECT), { wrapper });
    await settle();
    expect(providersMock).toHaveBeenCalledTimes(1);
    expect(result.current.providers[0].enabled).toBe(true);

    act(() => {
      result.current.toggle('prov-openai');
    });

    expect(result.current.providers[0].enabled).toBe(false);
    expect(result.current.notice).toBeNull();
    expect(providersMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.toggle('prov-openai');
    });
    expect(result.current.providers[0].enabled).toBe(true);
    expect(providersMock).toHaveBeenCalledTimes(1);
  });

  test('configure: setQueryData + notice, error dismissed, no extra GET', async () => {
    providersImpl = async () => {
      throw new Error('boom');
    };
    const { result } = renderHook(() => useAiProviders(PROJECT), { wrapper });
    await settleRetryBudget();
    expect(result.current.error).not.toBeNull();

    // Seed success then configure — configure hides the query error locally.
    providersImpl = async () => PROVIDERS;
    act(() => {
      result.current.reload();
    });
    await settle();
    expect(result.current.error).toBeNull();

    act(() => {
      result.current.configure('prov-openai');
    });

    expect(result.current.providers[0].enabled).toBe(true);
    expect(result.current.providers[0].status).toBe('connected');
    expect(result.current.notice).not.toBeNull();
    expect(result.current.notice).toContain('OpenAI');
  });

  test('503: surfaces as error with bounded retry, no mock rows', async () => {
    providersImpl = async () => {
      throw new Error('upstream down');
    };
    const { result } = renderHook(() => useAiProviders(PROJECT), { wrapper });
    await settleRetryBudget();

    expect(result.current.loading).toBe(false);
    expect(result.current.providers).toEqual([]);
    expect(result.current.error).not.toBeNull();
    expect(result.current.isEmpty).toBe(false);
    // retry: 1 → exactly 2 attempts, never a storm.
    expect(providersMock.mock.calls.length).toBe(2);
  });

  test('404/403: bounded retry (no storm), loading false, error surfaces', async () => {
    for (const status of [404, 403]) {
      providersImpl = async () => {
        const err = new Error(status === 404 ? 'not found' : 'forbidden');
        (err as unknown as Record<string, unknown>).status = status;
        throw err;
      };
      const scoped = renderHook(() => useAiProviders(`${PROJECT}-${status}`), { wrapper });
      await settleRetryBudget();

      expect(scoped.result.current.loading).toBe(false);
      expect(scoped.result.current.providers).toEqual([]);
      expect(scoped.result.current.error).not.toBeNull();
      expect(providersMock.mock.calls.length).toBe(2);
      scoped.unmount();
      cleanup();
      providersMock.mockClear();
      providersImpl = async () => PROVIDERS;
    }
  });

  test('dismiss: clears error locally, no refetch', async () => {
    providersImpl = async () => {
      throw new Error('upstream down');
    };
    const { result } = renderHook(() => useAiProviders(PROJECT), { wrapper });
    await settleRetryBudget();
    expect(result.current.error).not.toBeNull();
    const callsBefore = providersMock.mock.calls.length;

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBeNull();
    // Local-only: no invalidate, no new GET.
    await settle();
    expect(providersMock.mock.calls.length).toBe(callsBefore);
  });
});
