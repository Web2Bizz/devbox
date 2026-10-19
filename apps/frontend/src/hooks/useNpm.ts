'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import type { NpmPackageItem } from '../lib/types';
import { useI18n } from '../i18n';
import { NPM_QUERY_KEY } from './query-keys';

export interface UseNpmResult {
  packages: NpmPackageItem[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
}

/**
 * Shared fetch — GET /api/v1/registry/npm/status without a token (public
 * reachability; auth lives server-side in NPM_REGISTRY_* env, never
 * logged, never shipped to the browser). Throws the raw envelope on
 * failure (never formats); `formatApiError + t` mapping lives in
 * `useMemo` in `useNpm`. Module-level (no `t` closure) so concurrent
 * mounts share one cache entry AND one queryFn identity — dedup to a
 * single GET /registry/npm/status. Query cancellation arrives via the
 * `signal` argument (no local AbortController).
 */
async function fetchNpmStatus(signal?: AbortSignal): Promise<NpmPackageItem[]> {
  const data = await api.getNpmStatus(signal ? { signal } : undefined);
  const url = typeof data?.url === 'string' ? data.url : '';
  const scope = typeof data?.scope === 'string' ? data.scope : '';
  return [
    {
      id: 'default',
      name: scope || 'npm',
      url,
      scope,
      status: 'up',
    },
  ];
}

/**
 * Live npm status hook — GET /api/v1/registry/npm/status via TanStack
 * Query (contract unchanged: UseNpmResult shape is frozen, only the body
 * swaps useEffect+nonce → useQuery).
 * - Cache: NPM_QUERY_KEY (P0 single source), staleTime 60s (reachability
 *   probe is quasi-static — longer than the shared 30s default), gcTime
 *   from the shared QueryClient (no override).
 * - Deduplication: module-level fetchNpmStatus (no `t` closure) so
 *   concurrent mounts share one in-flight GET.
 * - Skeleton: `isLoading && !data` (initial only, refetch keeps data via
 *   placeholderData).
 * - Unreachable surfaces as `error` with retry — no silent mock payloads.
 */
export function useNpm(): UseNpmResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: NPM_QUERY_KEY,
    queryFn: ({ signal }) => fetchNpmStatus(signal),
    // Reachability probe is quasi-static — refetch less often than default.
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

  const packages = data ?? [];

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: NPM_QUERY_KEY });
  }, [queryClient]);

  // Initial skeleton only; background refetch keeps previous data visible
  const loading = isLoading && !data;

  return {
    packages,
    loading,
    error,
    isEmpty: !loading && !error && packages.length === 0,
    reload,
  };
}
