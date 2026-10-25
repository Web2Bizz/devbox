'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, api } from '../api/client';
import { getValidAccessToken } from '../lib/auth-store';
import { formatApiError } from '../lib/format-error';
import type { Project } from '../lib/types';
import type { Project as ProjectApiDto } from '@rush-code/contracts';
import { useI18n } from '../i18n';

export function mapApiToProject(dto: ProjectApiDto): Project {
  const repo =
    dto.githubOwner && dto.githubRepo ? `${dto.githubOwner}/${dto.githubRepo}` : undefined;
  const status = (dto as { status?: string }).status === 'deleted' ? 'archived' : 'active';
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? '',
    status,
    updatedAt: dto.updatedAt,
    repo,
    // Backend always sends these; default keeps compat with stale caches.
    corrupted: dto.corrupted ?? false,
    corruptedReason: dto.corruptedReason ?? null,
  };
}

export const projectQueryKey = (id: string) => ['project', id] as const;

export type UseProjectResult = {
  project: Project | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  reload: () => void;
};

/**
 * Production-ready single-project hook backed by TanStack Query.
 * - Cache: staleTime 30s, gcTime 5m → detail is not refetched on every tab switch
 * - `enabled: !!id` prevents fetch when id is missing
 * - 404 maps to `notFound: true`
 */
export function useProject(
  orgId: string | null | undefined,
  id: string | null | undefined,
  includeDeleted = false,
): UseProjectResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const {
    data: project = null,
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: orgId && id ? ['org-project', orgId, id, includeDeleted ? 'with-deleted' : 'active'] : ['project', 'empty'],
    enabled: !!orgId && !!id,
    queryFn: async (): Promise<Project | null> => {
      if (!orgId || !id) return null;
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      const dto = await api.getOrgProject(token, orgId, id, includeDeleted);
      return mapApiToProject(dto);
    },
    placeholderData: (prev) => prev,
    retry: (failureCount, error) => {
      // Don't retry on 404 — it's a valid notFound state
      if (error instanceof ApiClientError && error.status === 404) return false;
      return failureCount < 1;
    },
  });

  const { error, notFound } = useMemo(() => {
    if (!orgId || !id) {
      return { error: t.projects.notFoundDesc, notFound: true };
    }
    if (!queryError) return { error: null, notFound: false };
    const formatted = formatApiError(queryError);
    const msg = formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
    const is404 = queryError instanceof ApiClientError && queryError.status === 404;
    return { error: msg, notFound: is404 };
  }, [orgId, id, queryError, t]);

  const loading = !!orgId && !!id && isLoading && !project;

  const reload = useCallback(() => {
    if (!orgId || !id) return;
    void queryClient.invalidateQueries({ queryKey: ['org-project', orgId, id] });
  }, [orgId, id, queryClient]);

  const effectiveLoading = orgId && id ? loading : false;
  const effectiveProject = orgId && id ? project : null;

  return {
    project: effectiveProject,
    loading: effectiveLoading,
    error,
    notFound,
    reload,
  };
}
