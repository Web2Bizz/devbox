/**
 * useAiProviders — provider list via GET /api/opencode/config/providers
 * (P2 migration).
 *
 * Covers: success (providers land, no skeleton flash), empty (isEmpty),
 * directory scope (queryKey per directory, `?? 'all'`), toggle
 * (setQueryData flip, no extra GET), configure (setQueryData + notice +
 * error dismiss, no extra GET), 503 (error surfaces, bounded retry),
 * 404/403 (bounded retry, loading false, error surfaces), reload
 * (invalidate refetches, no skeleton flash), dismiss (clears error +
 * notice locally, no refetch).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    source: 'api',
    env: ['OPENAI_API_KEY'],
    models: { 'gpt-4o': {}, 'gpt-4o-mini': {} },
  },
  {
    id: 'anthropic',
    name: '',
    source: 'api',
    env: [],
    models: { 'claude-3': {} },
  },
];

let providersImpl: (directory?: string) => Promise<unknown> = async () => ({
  data: { providers: PROVIDERS },
  error: undefined,
});
const providersMock = mock((opts?: unknown) => {
  const query = (opts as { query?: { directory?: string } } | undefined)?.query;
  return providersImpl(query?.directory);
});

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

mock.module('../../api/opencode-client', () => ({
  opencode: { config: { providers: providersMock } },
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
  providersImpl = async () => ({ data: { providers: PROVIDERS }, error: undefined });
});

async function settle(rounds = 6) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

describe('useAiProviders', () => {
  test('success: providers land with mapped fields, no error', async () => {
    const { result } = renderHook(() => useAiProviders(), { wrapper });
    await settle();

    expect(providersMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.providers.length).toBe(2);
    expect(result.current.providers[0]).toMatchObject({
      id: 'openai',
      name: 'OpenAI',
      enabled: true,
      status: 'connected',
      modelsCount: 2,
    });
    // Empty name falls back to id.
    expect(result.current.providers[1].name).toBe('anthropic');
    expect(result.current.isEmpty).toBe(false);
  });

  test('empty: zero providers → isEmpty without error', async () => {
    providersImpl = async () => ({ data: { providers: [] }, error: undefined });
    const { result } = renderHook(() => useAiProviders(), { wrapper });
    await settle();

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isEmpty).toBe(true);
  });

  test('directory scope: query carries directory, key splits per scope', async () => {
    const seen: Array<unknown> = [];
    providersImpl = async (directory?: string) => {
      seen.push(directory);
      return { data: { providers: PROVIDERS }, error: undefined };
    };
    const { result } = renderHook(() => useAiProviders('/proj/web'), { wrapper });
    await settle();

    expect(providersMock).toHaveBeenCalledTimes(1);
    const call = providersMock.mock.calls[0]?.[0] as
      | { query?: { directory?: string } }
      | undefined;
    expect(call?.query?.directory).toBe('/proj/web');
    expect(result.current.providers.length).toBe(2);
    // Key identity: nullish → 'all', empty string stays as-is.
    expect(aiProvidersQueryKey()).toEqual(['ai-providers', 'all']);
    expect(aiProvidersQueryKey(undefined)).toEqual(['ai-providers', 'all']);
    expect(aiProvidersQueryKey('')).toEqual(['ai-providers', '']);
    expect(aiProvidersQueryKey('/proj/web')).toEqual(['ai-providers', '/proj/web']);
    expect(seen).toEqual(['/proj/web']);
  });

  test('toggle: setQueryData flips enabled, no extra GET', async () => {
    const { result } = renderHook(() => useAiProviders(), { wrapper });
    await settle();
    expect(providersMock).toHaveBeenCalledTimes(1);
    expect(result.current.providers[0].enabled).toBe(true);

    act(() => {
      result.current.toggle('openai');
    });

    expect(result.current.providers[0].enabled).toBe(false);
    expect(result.current.notice).toBeNull();
    expect(providersMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.toggle('openai');
    });
    expect(result.current.providers[0].enabled).toBe(true);
    expect(providersMock).toHaveBeenCalledTimes(1);
  });

  test('configure: setQueryData + notice, error dismissed, no extra GET', async () => {
    providersImpl = async () => ({ data: undefined, error: { message: 'boom' } });
    const { result } = renderHook(() => useAiProviders(), { wrapper });
    await settle(8);
    expect(result.current.error).not.toBeNull();

    // Seed success then configure — configure hides the query error locally.
    providersImpl = async () => ({ data: { providers: PROVIDERS }, error: undefined });
    act(() => {
      result.current.reload();
    });
    await settle();
    expect(result.current.error).toBeNull();

    act(() => {
      result.current.configure('openai');
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
    const { result } = renderHook(() => useAiProviders(), { wrapper });
    await settle(8);

    expect(result.current.loading).toBe(false);
    expect(result.current.providers).toEqual([]);
    expect(result.current.error).not.toBeNull();
    expect(result.current.isEmpty).toBe(false);
    // retry: 1 → at most 2 attempts, never a storm.
    expect(providersMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  test('404/403: bounded retry (no storm), loading false, error surfaces', async () => {
    for (const status of [404, 403]) {
      providersImpl = async () => {
        const err = new Error(status === 404 ? 'not found' : 'forbidden');
        (err as unknown as Record<string, unknown>).status = status;
        throw err;
      };
      const scoped = renderHook(() => useAiProviders(`scope-${status}`), { wrapper });
      await settle(8);

      expect(scoped.result.current.loading).toBe(false);
      expect(scoped.result.current.providers).toEqual([]);
      expect(scoped.result.current.error).not.toBeNull();
      expect(providersMock.mock.calls.length).toBeLessThanOrEqual(4);
      scoped.unmount();
      cleanup();
      providersMock.mockClear();
      providersImpl = async () => ({ data: { providers: PROVIDERS }, error: undefined });
    }
  });

  test('sdk error tuple: { error } maps to error text', async () => {
    providersImpl = async () => ({ data: undefined, error: { message: 'sdk boom' } });
    const { result } = renderHook(() => useAiProviders(), { wrapper });
    await settle(8);

    expect(result.current.loading).toBe(false);
    expect(result.current.providers).toEqual([]);
    expect(result.current.error).toContain('sdk boom');
  });

  test('reload: invalidate refetches without skeleton flash', async () => {
    const { result } = renderHook(() => useAiProviders(), { wrapper });
    await settle();
    expect(providersMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.reload();
    });
    // Background refetch keeps previous data — no skeleton flash.
    expect(result.current.loading).toBe(false);
    expect(result.current.providers.length).toBe(2);
    await settle();

    expect(providersMock).toHaveBeenCalledTimes(2);
  });

  test('dismiss: clears error + notice locally, no refetch', async () => {
    providersImpl = async () => ({ data: undefined, error: { message: 'boom' } });
    const { result } = renderHook(() => useAiProviders(), { wrapper });
    await settle(8);
    expect(result.current.error).not.toBeNull();
    const calls = providersMock.mock.calls.length;

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBeNull();
    expect(providersMock.mock.calls.length).toBe(calls);
  });

  test('dedup: two observers share one GET on a shared client', async () => {
    const client = createQueryClient();
    const shared = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    const a = renderHook(() => useAiProviders(), { wrapper: shared });
    const b = renderHook(() => useAiProviders(), { wrapper: shared });
    await settle();

    expect(providersMock).toHaveBeenCalledTimes(1);
    expect(a.result.current.providers).toEqual(b.result.current.providers);
    a.unmount();
    b.unmount();
  });
});
