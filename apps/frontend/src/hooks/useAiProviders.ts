'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError } from '../api/client';
import { listSessionProviders, toErrorMessage } from '../api/sessions-client';
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
 * Shared fetch — the project's provider inventory through the domain
 * route (GET /api/sessions/providers via api/sessions-client). Rows are
 * the contract `SessionRunnerProvider` shape (boundary-parsed in
 * ./client): id/name/activation/package — the REQUIRED artifact
 * Provider.Info subset; credential-bearing upstream members never reach
 * the browser. `enabled` mirrors the artifact activation semantics
 * (activation:'disabled' → off); `status`/`modelsCount` stay the frozen
 * UI display fields (this envelope carries no model inventory — honest
 * 0, never a fabricated count). The access gate is JWT
 * (`authorization: Bearer` via withAuth, never a runner key, the token
 * is never logged) + the C4 projectId gate: missing projectId fails
 * client-side with the same fixed PROJECT_REQUIRED the backend answers
 * (honest, no request, no default). `formatApiError + t` mapping lives
 * in `useMemo` outside the queryFn. Module-level (no `t` closure) so
 * concurrent mounts share one cache entry AND one queryFn identity per
 * project scope. Query cancellation arrives via the `signal` argument
 * (no local AbortController).
 */
async function fetchAiProviders(projectId?: string, signal?: AbortSignal): Promise<AiProvider[]> {
  if (!projectId) {
    throw new ApiClientError({
      code: 'PROJECT_REQUIRED',
      message: 'projectId is required — providers are project-scoped',
      status: 400,
      correlationId: 'client',
    });
  }
  const rows = await listSessionProviders(projectId, signal ? { signal } : {});
  return rows.map((p) => ({
    id: p.id,
    name: p.name || p.id,
    description: p.package,
    enabled: p.activation !== 'disabled',
    status: 'connected' as const,
    modelsCount: 0,
  }));
}

/**
 * Live provider list hook — TanStack Query (contract unchanged:
 * UseAiProvidersResult shape is frozen, only the body swaps useEffect+nonce
 * → useQuery).
 * - Cache: aiProvidersQueryKey(projectId) (P0 single source, `?? 'none'`
 *   scope so the default view has one stable entry), staleTime 60s
 *   (provider list is quasi-static — longer than the shared 30s
 *   default), gcTime from the shared QueryClient (no override).
 * - Deduplication: module-level fetchAiProviders (no `t` closure) so
 *   concurrent mounts share one in-flight GET per project scope.
 * - Skeleton: `isLoading && !data` (initial only, refetch keeps data via
 *   placeholderData).
 * - 503 (runner down) surfaces as `error` with retry — no silent mock
 *   payloads.
 * - Toggle/configure stay local-only (no backend write endpoints yet):
 *   they patch the cache via `setQueryData`, never a server write.
 */
export function useAiProviders(projectId?: string): UseAiProvidersResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => aiProvidersQueryKey(projectId), [projectId]);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchAiProviders(projectId, signal),
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
