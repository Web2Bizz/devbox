'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken } from '../lib/auth-store';
import type { OrganizationDto } from '../api/types';
import { useI18n } from '../i18n';

export const ORGANIZATIONS_QUERY_KEY = ['organizations'] as const;

export interface UseOrganizationsResult {
  organizations: OrganizationDto[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
  createOrganization: (name: string) => Promise<OrganizationDto>;
  creating: boolean;
  createError: string | null;
}

/**
 * Organizations list hook (etalon: useProjects).
 * - Cache: staleTime/gcTime from shared QueryClient (30s/5m) → no backend hammering
 * - Skeleton: `loading = isLoading && !data` (initial only, refetch keeps data)
 * - Mutations update cache via `setQueryData` + `invalidate` (eventual consistency)
 * - Errors via formatApiError + t (no fallbacks, no token material in strings)
 */
export function useOrganizations(): UseOrganizationsResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const {
    data: organizations = [],
    isLoading,
    isFetching,
    error: queryError,
  } = useQuery({
    queryKey: ORGANIZATIONS_QUERY_KEY,
    queryFn: async (): Promise<OrganizationDto[]> => {
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.listOrganizations(token);
    },
    // Keep previous data during refetch to avoid skeleton flash
    placeholderData: (prev) => prev,
  });

  const error = useMemo(() => {
    if (!queryError) return null;
    const formatted = formatApiError(queryError);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [queryError, t]);

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ORGANIZATIONS_QUERY_KEY });
  }, [queryClient]);

  const mutation = useMutation({
    mutationFn: async (name: string): Promise<OrganizationDto> => {
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.createOrganization(token, { name: name.trim() });
    },
    onSuccess: (created) => {
      // Optimistically prepend without extra network roundtrip
      queryClient.setQueryData<OrganizationDto[]>(ORGANIZATIONS_QUERY_KEY, (old) =>
        old ? [created, ...old] : [created],
      );
      // Ensure eventual consistency (background revalidation, deduped by cache)
      void queryClient.invalidateQueries({ queryKey: ORGANIZATIONS_QUERY_KEY });
    },
  });

  const createOrganization = useCallback(
    async (name: string): Promise<OrganizationDto> => {
      return mutation.mutateAsync(name);
    },
    [mutation],
  );

  const createError = useMemo(() => {
    if (!mutation.error) return null;
    const formatted = formatApiError(mutation.error);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [mutation.error, t]);

  // Initial skeleton only; background refetch keeps previous data visible
  const loading = isLoading && organizations.length === 0;

  // isEmpty only when not loading and no error and no data
  const isEmpty = !loading && !error && organizations.length === 0;

  void isFetching;

  return {
    organizations,
    loading,
    error,
    isEmpty,
    reload,
    createOrganization,
    creating: mutation.isPending,
    createError,
  };
}
