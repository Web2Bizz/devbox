'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken } from '../lib/auth-store';
import type { MemberDto, OrgRole } from '../api/types';
import { useI18n } from '../i18n';

export const orgMembersQueryKey = (orgId: string) => ['organization-members', orgId] as const;

export interface UseOrgMembersResult {
  members: MemberDto[];
  loading: boolean;
  error: string | null;
  notFound: boolean;
  reload: () => void;
  addMember: (userId: string, role?: OrgRole) => Promise<MemberDto>;
  changeRole: (userId: string, role: OrgRole) => Promise<MemberDto>;
  removeMember: (userId: string) => Promise<void>;
  mutating: boolean;
  mutationError: string | null;
}

/**
 * Organization members hook (etalon: useProjects mutation pattern).
 * - GET /organizations/:id/members (members only); mutations maintainer-only
 * - Cache: setQueryData + invalidate on every mutation (list stays fresh)
 * - Errors via formatApiError + t; 404 → notFound; 400/409 surface as
 *   mutationError strings for the page to map (last-maintainer / double-link)
 */
export function useOrgMembers(orgId: string | null | undefined): UseOrgMembersResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const key = orgId ? orgMembersQueryKey(orgId) : (['organization-members', 'empty'] as const);

  const {
    data: members = [],
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: key,
    enabled: !!orgId,
    queryFn: async (): Promise<MemberDto[]> => {
      if (!orgId) return [];
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.listOrgMembers(token, orgId);
    },
    placeholderData: (prev) => prev,
    retry: (failureCount, error) => {
      if (error instanceof ApiClientError && (error.status === 404 || error.status === 403))
        return false;
      return failureCount < 1;
    },
  });

  const { error, notFound } = useMemo(() => {
    if (!orgId) return { error: null as string | null, notFound: false };
    if (!queryError) return { error: null as string | null, notFound: false };
    const formatted = formatApiError(queryError);
    const msg = formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
    const is404 = queryError instanceof ApiClientError && queryError.status === 404;
    return { error: msg, notFound: is404 };
  }, [orgId, queryError, t]);

  const reload = useCallback(() => {
    if (!orgId) return;
    void queryClient.invalidateQueries({ queryKey: orgMembersQueryKey(orgId) });
  }, [orgId, queryClient]);

  const refresh = useCallback(
    (org: string) => {
      void queryClient.invalidateQueries({ queryKey: orgMembersQueryKey(org) });
    },
    [queryClient],
  );

  const addMutation = useMutation({
    mutationFn: async (input: { userId: string; role?: OrgRole }): Promise<MemberDto> => {
      if (!orgId) throw new Error(t.orgs.notFoundDesc);
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.addOrgMember(token, orgId, input);
    },
    onSuccess: (created) => {
      if (!orgId) return;
      queryClient.setQueryData<MemberDto[]>(orgMembersQueryKey(orgId), (old) =>
        old ? [...old, created] : [created],
      );
      refresh(orgId);
    },
  });

  const roleMutation = useMutation({
    mutationFn: async (input: { userId: string; role: OrgRole }): Promise<MemberDto> => {
      if (!orgId) throw new Error(t.orgs.notFoundDesc);
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.changeOrgMemberRole(token, orgId, input.userId, { role: input.role });
    },
    onSuccess: (updated) => {
      if (!orgId) return;
      queryClient.setQueryData<MemberDto[]>(orgMembersQueryKey(orgId), (old) =>
        old ? old.map((m) => (m.userId === updated.userId ? updated : m)) : [updated],
      );
      refresh(orgId);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string): Promise<string> => {
      if (!orgId) throw new Error(t.orgs.notFoundDesc);
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      await api.removeOrgMember(token, orgId, userId);
      return userId;
    },
    onSuccess: (userId) => {
      if (!orgId) return;
      queryClient.setQueryData<MemberDto[]>(orgMembersQueryKey(orgId), (old) =>
        old ? old.filter((m) => m.userId !== userId) : [],
      );
      refresh(orgId);
    },
  });

  const addMember = useCallback(
    (userId: string, role?: OrgRole) => addMutation.mutateAsync({ userId, role }),
    [addMutation],
  );
  const changeRole = useCallback(
    (userId: string, role: OrgRole) => roleMutation.mutateAsync({ userId, role }),
    [roleMutation],
  );
  const removeMember = useCallback(
    (userId: string) => removeMutation.mutateAsync(userId).then(() => undefined),
    [removeMutation],
  );

  const mutationError = useMemo(() => {
    const err = addMutation.error ?? roleMutation.error ?? removeMutation.error;
    if (!err) return null;
    const formatted = formatApiError(err);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [addMutation.error, roleMutation.error, removeMutation.error, t]);

  const loading = !!orgId && isLoading && members.length === 0;

  return {
    members: orgId ? members : [],
    loading,
    error,
    notFound,
    reload,
    addMember,
    changeRole,
    removeMember,
    mutating: addMutation.isPending || roleMutation.isPending || removeMutation.isPending,
    mutationError,
  };
}
