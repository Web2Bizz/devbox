'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import type { RegistryItem } from '../lib/types';
import { useI18n } from '../i18n';
import { REGISTRIES_QUERY_KEY } from './query-keys';

export interface UseRegistriesResult {
  registries: RegistryItem[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
}

/**
 * Shared fetch — GET /api/v1/registry/catalog without a token (public
 * reachability; auth lives server-side in DOCKER_REGISTRY_* env, never
 * logged, never shipped to the browser). Throws the raw envelope on
 * failure (never formats); `formatApiError + t` mapping lives in
 * `useMemo` in `useRegistries`. Module-level (no `t` closure) so
 * concurrent mounts share one cache entry AND one queryFn identity —
 * dedup to a single GET /registry/catalog. Query cancellation arrives
 * via the `signal` argument (no local AbortController).
 */
async function fetchRegistries(signal?: AbortSignal): Promise<RegistryItem[]> {
  const data = await api.getRegistryCatalog(signal ? { signal } : undefined);
  const repos = Array.isArray(data?.repositories) ? data.repositories : [];
  return [
    {
      id: 'default',
      name: 'default',
      url: '',
      status: 'up',
      repositories: repos,
    },
  ];
}

/**
 * Live registry catalog hook — GET /api/v1/registry/catalog via TanStack
 * Query (contract unchanged: UseRegistriesResult shape is frozen, only the
 * body swaps useEffect+nonce → useQuery).
 * - Cache: REGISTRIES_QUERY_KEY (P0 single source), staleTime 60s
 *   (catalog is quasi-static — longer than the shared 30s default),
 *   gcTime from the shared QueryClient (no override).
 * - Deduplication: module-level fetchRegistries (no `t` closure) so
 *   concurrent mounts share one in-flight GET.
 * - Skeleton: `isLoading && !data` (initial only, refetch keeps data via
 *   placeholderData).
 * - 503 (unconfigured/unreachable) surfaces as `error` with retry —
 *   no silent mock payloads.
 */
export function useRegistries(): UseRegistriesResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: REGISTRIES_QUERY_KEY,
    queryFn: ({ signal }) => fetchRegistries(signal),
    // Catalog is quasi-static — refetch less often than the shared default.
    staleTime: 60_000,
    // Keep previous data during refetch to avoid skeleton flash
    placeholderData: (prev) => prev,
    retry: 1,
  });

  const error = useMemo(() => {
    if (!queryError) return null;
    const formatted = formatApiError(queryError);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [queryError, t]);

  const registries = data ?? [];

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: REGISTRIES_QUERY_KEY });
  }, [queryClient]);

  // Initial skeleton only; background refetch keeps previous data visible
  const loading = isLoading && !data;

  return {
    registries,
    loading,
    error,
    isEmpty: !loading && !error && registries.length === 0,
    reload,
  };
}
