'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken } from '../lib/auth-store';
import type { Organization as OrganizationDto, UpdateOrganizationInput as UpdateOrganizationRequest } from '@rush-code/contracts';
import { useI18n } from '../i18n';
import { ORGANIZATIONS_QUERY_KEY } from './useOrganizations';

export const organizationQueryKey = (id: string) => ['organization', id] as const;

export type UseOrganizationResult = {
  organization: OrganizationDto | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  forbidden: boolean;
  reload: () => void;
  update: (patch: UpdateOrganizationRequest) => Promise<OrganizationDto>;
  updating: boolean;
  updateError: string | null;
  remove: () => Promise<void>;
  removing: boolean;
  removeError: string | null;
};

/**
 * Single-organization hook (etalon: useProject).
 * - Cache: shared QueryClient defaults; `enabled: !!id`; 404 → notFound, 403 → forbidden
 * - Mutations update cache via `setQueryData` + `invalidate` (list + detail)
 * - Errors via formatApiError + t; 404 maps to notFound (no retry on 404/403)
 */
export function useOrganization(id: string | null | undefined): UseOrganizationResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const {
    data: organization = null,
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: id ? organizationQueryKey(id) : ['organization', 'empty'],
    enabled: !!id,
    queryFn: async (): Promise<OrganizationDto | null> => {
      if (!id) return null;
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.getOrganization(token, id);
    },
    placeholderData: (prev) => prev,
    retry: (failureCount, error) => {
      // Don't retry on 404/403 — valid terminal states
      if (error instanceof ApiClientError && (error.status === 404 || error.status === 403))
        return false;
      return failureCount < 1;
    },
  });

  const { error, notFound, forbidden } = useMemo(() => {
    if (!id) {
      return { error: t.orgs.notFoundDesc, notFound: true, forbidden: false };
    }
    if (!queryError) return { error: null, notFound: false, forbidden: false };
    const formatted = formatApiError(queryError);
    const msg = formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
    const is404 = queryError instanceof ApiClientError && queryError.status === 404;
    const is403 = queryError instanceof ApiClientError && queryError.status === 403;
    return { error: msg, notFound: is404, forbidden: is403 };
  }, [id, queryError, t]);

  const loading = !!id && isLoading && !organization;

  const reload = useCallback(() => {
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: organizationQueryKey(id) });
  }, [id, queryClient]);

  const updateMutation = useMutation({
    mutationFn: async (patch: UpdateOrganizationRequest): Promise<OrganizationDto> => {
      if (!id) throw new Error(t.orgs.notFoundDesc);
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.updateOrganization(token, id, patch);
    },
    onSuccess: (updated) => {
      if (!id) return;
      queryClient.setQueryData<OrganizationDto | null>(organizationQueryKey(id), updated);
      queryClient.setQueryData<OrganizationDto[]>(ORGANIZATIONS_QUERY_KEY, (old) =>
        old ? old.map((o) => (o.id === updated.id ? updated : o)) : [updated],
      );
      void queryClient.invalidateQueries({ queryKey: organizationQueryKey(id) });
      void queryClient.invalidateQueries({ queryKey: ORGANIZATIONS_QUERY_KEY });
    },
  });

  const update = useCallback(
    (patch: UpdateOrganizationRequest) => updateMutation.mutateAsync(patch),
    [updateMutation],
  );

  const updateError = useMemo(() => {
    if (!updateMutation.error) return null;
    const formatted = formatApiError(updateMutation.error);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [updateMutation.error, t]);

  const removeMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!id) throw new Error(t.orgs.notFoundDesc);
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      await api.deleteOrganization(token, id);
    },
    onSuccess: () => {
      if (!id) return;
      queryClient.setQueryData<OrganizationDto | null>(organizationQueryKey(id), null);
      queryClient.setQueryData<OrganizationDto[]>(ORGANIZATIONS_QUERY_KEY, (old) =>
        old ? old.filter((o) => o.id !== id) : [],
      );
      void queryClient.invalidateQueries({ queryKey: ORGANIZATIONS_QUERY_KEY });
    },
  });

  const remove = useCallback(() => removeMutation.mutateAsync(), [removeMutation]);

  const removeError = useMemo(() => {
    if (!removeMutation.error) return null;
    const formatted = formatApiError(removeMutation.error);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [removeMutation.error, t]);

  return {
    organization: id ? organization : null,
    loading: id ? loading : false,
    error,
    notFound,
    forbidden,
    reload,
    update,
    updating: updateMutation.isPending,
    updateError,
    remove,
    removing: removeMutation.isPending,
    removeError,
  };
}
