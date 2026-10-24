'use client';

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, api } from '../api/client';
import type { AuthUser } from '@rush-code/contracts';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken, refreshAccessToken } from '../lib/auth-store';
import { PROFILE_QUERY_KEY } from './query-keys';
import type { Profile } from '../lib/types';
import { useI18n } from '../i18n';

export type UseProfileResult = {
  profile: Profile | null;
  loading: boolean;
  error: string | null;
  saved: boolean;
  saving: boolean;
  update: (patch: Pick<Profile, 'name'> & Partial<Pick<Profile, 'email'>>) => Promise<boolean>;
  reload: () => void;
  dismiss: () => void;
};

function toProfile(user: AuthUser & { limits?: Profile['limits'] }): Profile {
  return {
    id: user.id,
    name: `${user.firstName} ${user.lastName}`.trim(),
    email: user.email,
    createdAt: user.createdAt,
    ...(user.limits ? { limits: user.limits } : {}),
  };
}

/** Splits the single `name` field back into first/last for PATCH /auth/me. */
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') || (parts[0] ?? '') };
}

/**
 * Dead-session marker — thrown when both tokens are gone (no backend
 * envelope to throw). Mapped to `t.errors.sessionExpired` in `useMemo`
 * outside `queryFn`, so the fetch itself stays locale-free: language
 * switches neither refetch nor re-render identity consumers.
 */
class SessionExpiredError extends Error {
  constructor() {
    super('session-expired');
    this.name = 'SessionExpiredError';
  }
}

/**
 * Shared fetch — token → api.me → toProfile with one silent 401 refresh
 * retry (same auth contract `lib/auth-store.ts` documents). Throws the raw
 * envelope on failure (never formats); `formatApiError + t` mapping lives
 * in `useMemo` in `useProfile`. Module-level (no `t` closure) so header and
 * page observers share one cache entry AND one queryFn identity — concurrent
 * mounts dedup to a single GET /auth/me.
 */
async function fetchProfile(): Promise<Profile> {
  const token = await getValidAccessToken();
  if (!token) throw new SessionExpiredError();
  try {
    return toProfile(await api.me(token));
  } catch (e) {
    if (e instanceof ApiClientError && e.status === 401) {
      const retryToken = await refreshAccessToken();
      if (!retryToken) throw new SessionExpiredError();
      return toProfile(await api.me(retryToken));
    }
    throw e;
  }
}

/**
 * No retry on terminal auth states (dead session / session 401 — a retry
 * would only hammer /auth/me); one retry otherwise (shared-client contract).
 */
function profileRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiClientError && error.status === 401) return false;
  if (error instanceof SessionExpiredError) return false;
  return failureCount < 1;
}

/**
 * Profile hook — GET/PATCH /api/v1/auth/me via TanStack Query (contract
 * unchanged: UseProfileResult shape is frozen, only the body swapped
 * useEffect+nonce → useQuery + useMutation).
 * - Cache: staleTime 30s, gcTime 5m from the shared QueryClient (no override).
 * - Deduplication: same PROFILE_QUERY_KEY as useHeaderProfile → header +
 *   /profile + org-page mounts share one in-flight request.
 * - Skeleton: `isLoading && !data` (initial only, refetch keeps data via
 *   placeholderData).
 * - Update: PATCH via useMutation, cache patched via setQueryData (no extra
 *   GET); saving = isPending, saved is local UI state.
 */
export function useProfile(): UseProfileResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: fetchProfile,
    // Keep previous data during refetch to avoid skeleton flash
    placeholderData: (prev) => prev,
    retry: profileRetry,
  });

  const profile = data ?? null;

  const queryErrorText = useMemo(() => {
    if (!queryError) return null;
    if (queryError instanceof SessionExpiredError) return t.errors.sessionExpired;
    const formatted = formatApiError(queryError);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [queryError, t]);

  const mutation = useMutation({
    mutationFn: async (
      patch: Pick<Profile, 'name'> & Partial<Pick<Profile, 'email'>>,
    ): Promise<Profile> => {
      if (!patch.name.trim()) throw new Error(t.validation.nameRequired);
      // Email is read-only: backend PATCH /auth/me accepts only
      // firstName/lastName — patch.email (if passed by legacy callers)
      // is intentionally ignored, never validated nor sent.
      const token = await getValidAccessToken();
      if (!token) throw new SessionExpiredError();
      const attempt = (accessToken: string) => {
        const { firstName, lastName } = splitName(patch.name);
        return api.updateMe(accessToken, { firstName, lastName });
      };
      try {
        return toProfile(await attempt(token));
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 401) {
          const retryToken = await refreshAccessToken();
          if (!retryToken) throw new SessionExpiredError();
          return toProfile(await attempt(retryToken));
        }
        throw e;
      }
    },
    onSuccess: (updated) => {
      // Patch the cache directly — no extra GET roundtrip; header + page
      // observers re-render from the same PROFILE_QUERY_KEY entry.
      queryClient.setQueryData<Profile>(PROFILE_QUERY_KEY, updated);
      setSaved(true);
    },
    onError: () => {
      setSaved(false);
    },
  });

  const mutationErrorText = useMemo(() => {
    if (!mutation.error) return null;
    if (mutation.error instanceof SessionExpiredError) return t.errors.sessionExpired;
    const formatted = formatApiError(mutation.error);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [mutation.error, t]);

  const error = mutationErrorText ?? queryErrorText;

  const update = useCallback(
    async (patch: Pick<Profile, 'name'> & Partial<Pick<Profile, 'email'>>) => {
      setSaved(false);
      try {
        await mutation.mutateAsync(patch);
        return true;
      } catch {
        return false;
      }
    },
    [mutation],
  );

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
  }, [queryClient]);

  const dismiss = useCallback(() => {
    // Local-only: clears the mutation error + saved flag. Never touches the
    // query cache (no invalidate/clear — header + page stay consistent).
    mutation.reset();
    setSaved(false);
  }, [mutation]);

  // Initial skeleton only; background refetch keeps previous data visible
  const loading = isLoading && !profile;

  return { profile, loading, error, saved, saving: mutation.isPending, update, reload, dismiss };
}

/**
 * Header-only identity hook — same PROFILE_QUERY_KEY (same cache entry and
 * queryFn as useProfile, so header + page dedup to one GET /auth/me), sliced
 * via `select` to the data the header renders. NO useI18n subscription:
 * locale switches neither refetch /auth/me nor re-render
 * HeaderProfileDropdown (its userMenu labels are a mount snapshot there).
 * No translated error strings — the header only renders skeleton /
 * unauthorized states; useProfile (with live `t`) stays the single source
 * for the /profile page, whose error translations are untouched.
 */
export function useHeaderProfile(): { profile: Profile | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: fetchProfile,
    placeholderData: (prev) => prev,
    retry: profileRetry,
    // Slice: the header observes data only — error/saved/mutation updates
    // (translated in useProfile) never remap this observer.
    select: (fetched) => fetched,
  });

  const profile = data ?? null;
  const loading = isLoading && !profile;

  return { profile, loading };
}
