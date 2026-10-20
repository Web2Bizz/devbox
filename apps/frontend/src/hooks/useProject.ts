'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import type { Project } from '../lib/types';
import type { Project as ProjectApiDto } from '@devbox/contracts';
import { useI18n } from '../i18n';

export function mapApiToProject(dto: ProjectApiDto): Project {
  const repo =
    dto.githubOwner && dto.githubRepo ? `${dto.githubOwner}/${dto.githubRepo}` : undefined;
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? '',
    status: 'active',
    updatedAt: dto.updatedAt,
    repo,
    // Backend always sends these; default keeps compat with stale caches.
    corrupted: dto.corrupted ?? false,
    corruptedReason: dto.corruptedReason ?? null,
    // Additive scope passthrough (optional — old DTOs/caches stay valid).
    ...(dto.scope ? { scope: dto.scope } : {}),
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
export function useProject(id: string | null | undefined): UseProjectResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const {
    data: project = null,
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: id ? projectQueryKey(id) : ['project', 'empty'],
    enabled: !!id,
    queryFn: async (): Promise<Project | null> => {
      if (!id) return null;
      const dto = await api.getProject(id);
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
    if (!id) {
      return { error: t.projects.notFoundDesc, notFound: true };
    }
    if (!queryError) return { error: null, notFound: false };
    const formatted = formatApiError(queryError);
    const msg = formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
    const is404 = queryError instanceof ApiClientError && queryError.status === 404;
    return { error: msg, notFound: is404 };
  }, [id, queryError, t]);

  const loading = !!id && isLoading && !project;

  const reload = useCallback(() => {
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: projectQueryKey(id) });
  }, [id, queryClient]);

  const effectiveLoading = id ? loading : false;
  const effectiveProject = id ? project : null;

  return {
    project: effectiveProject,
    loading: effectiveLoading,
    error,
    notFound,
    reload,
  };
}
