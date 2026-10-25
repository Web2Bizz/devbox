'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken } from '../lib/auth-store';
import { mapApiToProject } from './useProjects';
import type { Project } from '../lib/types';
import { useI18n } from '../i18n';

export const orgProjectsQueryKey = (orgId: string, includeDeleted = false) =>
  ['org-projects', orgId, includeDeleted ? 'with-deleted' : 'active'] as const;

export type UseOrgProjectsResult = {
  projects: Project[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
  createProject: (name: string) => Promise<Project>;
  creating: boolean;
  createError: string | null;
};

/**
 * Canonical org-scoped project list (GET /organizations/:id/projects).
 * No orgId → hook errors (no fallback to first org).
 */
export function useOrgProjects(orgId: string | null | undefined, includeDeleted = false): UseOrgProjectsResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const {
    data: projects = [],
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: orgId ? orgProjectsQueryKey(orgId, includeDeleted) : ['org-projects', 'empty'],
    enabled: !!orgId,
    queryFn: async (): Promise<Project[]> => {
      if (!orgId) throw new Error(t.errors.unexpected);
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      const dtos = await api.listOrgProjects(token, orgId, includeDeleted);
      return dtos.map(mapApiToProject);
    },
    placeholderData: (prev) => prev,
  });

  const error = useMemo(() => {
    if (!orgId) return t.errors.unexpected;
    if (!queryError) return null;
    const formatted = formatApiError(queryError);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [orgId, queryError, t]);

  const reload = useCallback(() => {
    if (!orgId) return;
    void queryClient.invalidateQueries({ queryKey: orgProjectsQueryKey(orgId, includeDeleted) });
  }, [orgId, includeDeleted, queryClient]);

  const mutation = useMutation({
    mutationFn: async (name: string): Promise<Project> => {
      if (!orgId) throw new Error(t.errors.unexpected);
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      const dto = await api.createOrgProject(token, orgId, { orgId, name: name.trim() });
      return mapApiToProject(dto);
    },
    onSuccess: (created) => {
      if (!orgId) return;
      queryClient.setQueryData<Project[]>(orgProjectsQueryKey(orgId, includeDeleted), (old) =>
        old ? [created, ...old] : [created],
      );
      void queryClient.invalidateQueries({ queryKey: orgProjectsQueryKey(orgId, includeDeleted) });
    },
  });

  const createProject = useCallback(
    async (name: string): Promise<Project> => mutation.mutateAsync(name),
    [mutation],
  );

  const createError = useMemo(() => {
    if (!mutation.error) return null;
    const formatted = formatApiError(mutation.error);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [mutation.error, t]);

  const loading = isLoading && projects.length === 0;
  const isEmpty = !loading && !error && projects.length === 0;

  return { projects, loading, error, isEmpty, reload, createProject, creating: mutation.isPending, createError };
}
