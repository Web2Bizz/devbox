'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken } from '../lib/auth-store';
import type { AuthUser } from '../api/types';
import { useI18n } from '../i18n';

export const userQueryKey = (id: string) => ['user', id] as const;

export interface UseUserResult {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  /** True when the backend refused with 403 (someone else's profile — never indexed). */
  forbidden: boolean;
  reload: () => void;
}

/**
 * Single-user hook — GET /api/v1/users/:id (own profile only).
 * - 403 ( чужой id) → forbidden + ErrorState «доступ запрещён», no retry
 * - 404 → notFound, no retry
 * - Errors via formatApiError + t. No list fetching — single id only.
 */
export function useUser(id: string | null | undefined): UseUserResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const {
    data: user = null,
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: id ? userQueryKey(id) : ['user', 'empty'],
    enabled: !!id,
    queryFn: async (): Promise<AuthUser | null> => {
      if (!id) return null;
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.getUser(token, id);
    },
    placeholderData: (prev) => prev,
    retry: (failureCount, error) => {
      // Don't retry on 403/404 — valid terminal privacy states
      if (error instanceof ApiClientError && (error.status === 403 || error.status === 404))
        return false;
      return failureCount < 1;
    },
  });

  const { error, notFound, forbidden } = useMemo(() => {
    if (!id) {
      return { error: t.users.notFoundDesc, notFound: true, forbidden: false };
    }
    if (!queryError) return { error: null, notFound: false, forbidden: false };
    if (queryError instanceof ApiClientError && queryError.status === 403) {
      return { error: t.users.forbiddenDesc, notFound: false, forbidden: true };
    }
    const formatted = formatApiError(queryError);
    const msg = formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
    const is404 = queryError instanceof ApiClientError && queryError.status === 404;
    return { error: msg, notFound: is404, forbidden: false };
  }, [id, queryError, t]);

  const loading = !!id && isLoading && !user;

  const reload = useCallback(() => {
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: userQueryKey(id) });
  }, [id, queryClient]);

  return {
    user: id ? user : null,
    loading: id ? loading : false,
    error,
    notFound,
    forbidden,
    reload,
  };
}

/** Re-export for the header/profile bridge: own id comes from GET /auth/me. */
export type { AuthUser };
