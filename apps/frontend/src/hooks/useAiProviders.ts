'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchRunnerProviders, toErrorMessage } from '../api/sessions-client';
import { formatApiError } from '../lib/format-error';
import type { AiProvider } from '../lib/types';
import { useI18n } from '../i18n';
import { aiProvidersQueryKey } from './query-keys';

export type UseAiProvidersResult = {
  providers: AiProvider[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  isEmpty: boolean;
  toggle: (id: string) => void;
  configure: (id: string) => void;
  reload: () => void;
  dismiss: () => void;
};

/**
 * Shared fetch — the provider list. TODO(card 6): the domain contract has
 * no provider inventory route yet, so this rides the deprecated
 * /api/opencode/config/providers mirror through api/sessions-client
 * (fetchRunnerProviders → ./client api.providers) — one of the two
 * documented alias exceptions; nothing here imports an sdk. The answer is
 * the runner's provider envelope unwrapped to rows by the facade; per row
 * only `id`/`name` are proven by the wire contract (the rest are legacy
 * extras read through typeof guards, never invented). The access gate is
 * JWT (`authorization: Bearer` via withAuth, never an runner key, the
 * token is never logged). `formatApiError + t` mapping lives in `useMemo`
 * in `useAiProviders`. Module-level (no `t` closure) so concurrent mounts
 * share one cache entry AND one queryFn identity per directory scope.
 * Query cancellation arrives via the `signal` argument (no local
 * AbortController).
 */
async function fetchAiProviders(directory?: string, signal?: AbortSignal): Promise<AiProvider[]> {
  const rows = await fetchRunnerProviders({ directory, ...(signal ? { signal } : {}) });
  return rows.map((p) => {
    const id = typeof p.id === 'string' ? p.id : '';
    const source = typeof p.source === 'string' ? p.source : '';
    const env = Array.isArray(p.env) ? p.env.filter((e): e is string => typeof e === 'string') : [];
    const models = p.models && typeof p.models === 'object' ? Object.keys(p.models).length : 0;
    return {
      id,
      name: typeof p.name === 'string' && p.name ? p.name : id,
      description: `${source}${env.length ? ` · ${env.join(', ')}` : ''}`,
      enabled: true,
      status: 'connected' as const,
      modelsCount: models,
    };
  });
}

/**
 * Live provider list hook — TanStack Query (contract unchanged:
 * UseAiProvidersResult shape is frozen, only the body swaps useEffect+nonce
 * → useQuery).
 * - Cache: aiProvidersQueryKey(directory) (P0 single source, `?? 'all'`
 *   scope so the default view has one stable entry), staleTime 60s
 *   (provider list is quasi-static — longer than the shared 30s
 *   default), gcTime from the shared QueryClient (no override).
 * - Deduplication: module-level fetchAiProviders (no `t` closure) so
 *   concurrent mounts share one in-flight GET per directory scope.
 * - Skeleton: `isLoading && !data` (initial only, refetch keeps data via
 *   placeholderData).
 * - 503 (upstream down) surfaces as `error` with retry — no silent mock
 *   payloads.
 * - Toggle/configure stay local-only (no backend write endpoints yet):
 *   they patch the cache via `setQueryData`, never a server write.
 */
export function useAiProviders(directory?: string): UseAiProvidersResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => aiProvidersQueryKey(directory), [directory]);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchAiProviders(directory, signal),
    // Provider list is quasi-static — refetch less often than default.
    staleTime: 60_000,
    // Keep previous data during refetch to avoid skeleton flash
    placeholderData: (prev) => prev,
    retry: 1,
  });

  const queryErrorText = useMemo(() => {
    if (!queryError) return null;
    let formatted: string;
    try {
      formatted = formatApiError(queryError);
    } catch {
      formatted = toErrorMessage(queryError);
    }
    if (formatted === 'Unexpected error') {
      const alt = toErrorMessage(queryError);
      formatted = alt;
    }
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [queryError, t]);

  const error = errorDismissed ? null : queryErrorText;

  const providers = data ?? [];

  const toggle = useCallback(
    (id: string) => {
      setNotice(null);
      queryClient.setQueryData<AiProvider[]>(queryKey, (old) =>
        (old ?? []).map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)),
      );
    },
    [queryClient, queryKey],
  );

  const configure = useCallback(
    (id: string) => {
      setNotice(null);
      // Local-only until backend write endpoints exist (no POST/PATCH for
      // providers upstream yet) — flip the row on and surface the notice.
      // Hide the query error like the legacy setError(null) did.
      setErrorDismissed(true);
      const target = queryClient.getQueryData<AiProvider[]>(queryKey)?.find((p) => p.id === id);
      queryClient.setQueryData<AiProvider[]>(queryKey, (old) =>
        (old ?? []).map((p) =>
          p.id === id ? { ...p, enabled: true, status: 'connected' as const } : p,
        ),
      );
      setNotice(t.aiProviders.connectedNotice(target?.name ?? id));
    },
    [queryClient, queryKey, t],
  );

  const reload = useCallback(() => {
    setErrorDismissed(false);
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const dismiss = useCallback(() => {
    // Local-only: clears the visible error + notice. Never touches the
    // query cache (no invalidate/clear — observers stay consistent).
    setErrorDismissed(true);
    setNotice(null);
  }, []);

  // Initial skeleton only; background refetch keeps previous data visible
  const loading = isLoading && !data;

  return {
    providers,
    loading,
    error,
    notice,
    isEmpty: !loading && !error && providers.length === 0,
    toggle,
    configure,
    reload,
    dismiss,
  };
}
