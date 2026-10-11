'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import type { Project } from '../lib/types';
import type { ProjectApiDto } from '../api/types';
import { useI18n } from '../i18n';

export const PROJECTS_QUERY_KEY = ['projects'] as const;

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

export interface UseProjectsResult {
  projects: Project[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
  createProject: (name: string) => Promise<Project>;
  creating: boolean;
  createError: string | null;
}

/**
 * Production-ready list hook backed by TanStack Query.
 * - Cache: staleTime 30s, gcTime 5m (from QueryClient defaults) → no hammering backend
 * - Deduplication: concurrent mounts share one in-flight request
 * - Skeleton: `loading = isLoading && !data` (initial load only, background refetch keeps data)
 * - Mutations update cache via `setQueryData` + `invalidate` to keep list fresh
 */
export function useProjects(): UseProjectsResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const {
    data: projects = [],
    isLoading,
    isFetching,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async (): Promise<Project[]> => {
      const dtos = await api.listProjects();
      return dtos.map(mapApiToProject);
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
    void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
  }, [queryClient]);

  // Alternative explicit refetch (used internally if needed)
  // const reload = useCallback(() => void refetch(), [refetch]);

  const mutation = useMutation({
    mutationFn: async (name: string): Promise<Project> => {
      const dto = await api.createProject({ name: name.trim() });
      return mapApiToProject(dto);
    },
    onSuccess: (created) => {
      // Optimistically prepend without extra network roundtrip
      queryClient.setQueryData<Project[]>(PROJECTS_QUERY_KEY, (old) =>
        old ? [created, ...old] : [created],
      );
      // Ensure eventual consistency (background revalidation, deduped by cache)
      void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
    },
  });

  const createProject = useCallback(
    async (name: string): Promise<Project> => {
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
  const loading = isLoading && projects.length === 0;

  // isEmpty only when not loading and no error and no data
  const isEmpty = !loading && !error && projects.length === 0;

  // Expose isFetching separately if caller wants subtle indicator, but keep loading simple
  void isFetching;
  void refetch;

  return {
    projects,
    loading,
    error,
    isEmpty,
    reload,
    createProject,
    creating: mutation.isPending,
    createError,
  };
}
