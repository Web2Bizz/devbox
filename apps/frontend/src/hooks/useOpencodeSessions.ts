'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { opencode, ensureOpencodeAuth, projectScope, toErrorMessage } from '../api/opencode-client';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken, refreshAccessToken } from '../lib/auth-store';
import { SessionExpiredError } from '../lib/session-expired';
import type { Session as ContractSession } from '@rush-code/contracts';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { useI18n } from '../i18n';
import { sessionsQueryKey } from './query-keys';

export type UseOpencodeSessionsResult = {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
  create: (title?: string) => Promise<Session | null>;
  creating: boolean;
  abort: (id: string) => Promise<void>;
  abortingId: string | null;
};

/**
 * Session list through the canonical v1 proxy (`GET /api/v1/sessions`,
 * no `opencode` word) + mutations through the SDK mirror
 * (`/api/opencode/session*`). Same loading/error/empty/reload contract
 * as useProjects.
 *
 * Split (deliberate, do not reunify without a plan change):
 * - list/reload → `api.listSessions(accessToken, projectId)` (contract
 *   Session[]: { id, title, createdAt ISO, model? }, project-scoped —
 *   missing projectId → 400 PROJECT_REQUIRED, no session →
 *   SessionExpiredError, down → 503).
 *   The rows are mapped to the SDK Session shape the tables already
 *   render (time/projectID/directory filled from the contract +
 *   hook props) so SessionsTab/RunningSessionsTab keep compiling.
 * - create/abort → SDK `opencode.session.*` on `/api/opencode/*`
 *   (unchanged, still carry `?projectId=` + compat `?directory=`).
 *
 * Auth: the list endpoint is JWT-guarded — the hook resolves the access
 * token via `getValidAccessToken()` and sends it as `authorization: Bearer`
 * (one silent `refreshAccessToken()` retry on 401, then the dead-session
 * message). No anonymous session list exists server-side.
 *
 * Scoping (C4): `projectId` (Rush Code prj-*) is REQUIRED on project pages
 * and travels as `?projectId=` on list/create/abort — the backend gates it
 * (missing → 400 PROJECT_REQUIRED) and maps it to the jailed content dir
 * server-side. `directory` is still forwarded as `?directory=` for
 * create/abort compatibility but the backend IGNORES it (project jail
 * wins). The list path drops `?directory=` entirely (projectId only).
 * `event.subscribe` is global — untouched.
 *
 * Signature keeps the positional `directory` string (old callers) plus the
 * `{ directory, projectId }` object form (project tabs) — same
 * `directoryOrOptions` idiom as useChat.
 *
 * Cache: `sessionsQueryKey(projectId)` (`['sessions', projectId ?? 'none']`,
 * single source in `query-keys.ts`), staleTime 30s, gcTime from the shared
 * QueryClient, placeholderData keeps previous rows during refetch,
 * retry 1 (none on terminal auth states — see `sessionsRetry`).
 * `queryFn` throws the raw envelope; `formatApiError + t` mapping lives
 * in `useMemo` outside `queryFn`.
 */
export type UseOpencodeSessionsOptions = {
  /** Opencode working directory, forwarded as `?directory=` (backend-ignored). */
  directory?: string;
  /** Rush Code project id (prj-*) — forwarded as `?projectId=` (backend-gated). */
  projectId?: string;
};

/**
 * Contract → SDK row mapping (tables render the SDK shape: time for the
 * updated badge, projectID/directory in the details row). Only id/title
 * travel the wire; timestamps fall back to now when unparseable.
 * Module-level (no `t` closure) so concurrent mounts share one cache
 * entry AND one queryFn identity per projectId scope.
 */
function toSdkSession(s: ContractSession, projectId?: string, directory?: string): Session {
  const ms = Date.parse(s.createdAt);
  const at = Number.isNaN(ms) ? Date.now() : ms;
  return {
    id: s.id,
    title: s.title,
    time: { created: at, updated: at },
    projectID: projectId ?? '',
    directory: directory ?? '',
    ...(s.model ? { model: s.model } : {}),
  } as unknown as Session;
}

/**
 * Shared fetch — GET /api/v1/sessions?projectId=… (no `?directory=` —
 * the backend scopes by the project jail). Throws the raw ApiClientError
 * on failure (never formats); `formatApiError + t` mapping lives in
 * `useMemo` in `useOpencodeSessions`. Module-level (no `t` closure) so
 * concurrent mounts share one in-flight GET per projectId scope.
 * Query cancellation arrives via the `signal` argument (no local
 * AbortController).
 *
 * Auth: the endpoint is JWT-guarded — the access token travels as
 * `authorization: Bearer` (same contract as `api.me` / `api.listOrgProjects`).
 * One silent refresh retry on 401 (see `lib/auth-store.ts`); a spent
 * refresh → `SessionExpiredError` (dead session, no backend envelope).
 */
async function fetchSessions(
  projectId?: string,
  directory?: string,
  signal?: AbortSignal,
): Promise<Session[]> {
  const token = await getValidAccessToken();
  if (!token) throw new SessionExpiredError();
  const opts = signal ? { signal } : {};
  try {
    const res = await api.listSessions(token, projectId, opts);
    return res.map((s) => toSdkSession(s, projectId, directory));
  } catch (e) {
    if (e instanceof ApiClientError && e.status === 401) {
      const retryToken = await refreshAccessToken();
      if (!retryToken) throw new SessionExpiredError();
      const res = await api.listSessions(retryToken, projectId, opts);
      return res.map((s) => toSdkSession(s, projectId, directory));
    }
    throw e;
  }
}

/**
 * No retry on terminal auth states (dead session / session 401 — a retry
 * would only hammer /sessions); one retry otherwise (shared-client contract).
 */
function sessionsRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiClientError && error.status === 401) return false;
  if (error instanceof SessionExpiredError) return false;
  return failureCount < 1;
}

export function useOpencodeSessions(
  directoryOrOptions?: string | UseOpencodeSessionsOptions,
): UseOpencodeSessionsResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // Backward-compat: positional `directory` string still works;
  // object form adds `{ directory, projectId }`.
  const directory =
    typeof directoryOrOptions === 'string' ? directoryOrOptions : directoryOrOptions?.directory;
  const projectId =
    typeof directoryOrOptions === 'string' ? undefined : directoryOrOptions?.projectId;
  const queryKey = useMemo(() => sessionsQueryKey(projectId), [projectId]);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchSessions(projectId, directory, signal),
    staleTime: 30_000,
    // Keep previous data during refetch to avoid skeleton flash
    placeholderData: (prev) => prev,
    retry: sessionsRetry,
    enabled: true,
  });

  const queryErrorText = useMemo(() => {
    if (!queryError) return null;
    if (queryError instanceof SessionExpiredError) return t.errors.sessionExpired;
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

  const createMutation = useMutation<Session, unknown, string | undefined>({
    mutationFn: async (title?: string): Promise<Session> => {
      await ensureOpencodeAuth();
      const createParams = {
        ...(title !== undefined ? { title } : {}),
        ...(directory ? { directory } : {}),
        ...projectScope(projectId),
      };
      const res = await opencode.session.create(createParams);
      if (res.error !== undefined || res.data === undefined) {
        throw new Error(toErrorMessage(res.error));
      }
      return res.data as Session;
    },
    onSuccess: (created) => {
      queryClient.setQueryData<Session[]>(queryKey, (old) =>
        old ? [created, ...old] : [created],
      );
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const abortMutation = useMutation<void, unknown, string>({
    mutationFn: async (id: string): Promise<void> => {
      await ensureOpencodeAuth();
      const abortParams = {
        sessionID: id,
        ...(directory ? { directory } : {}),
        ...projectScope(projectId),
      };
      const res = await opencode.session.abort(abortParams);
      if (res.error !== undefined) {
        throw new Error(toErrorMessage(res.error));
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const mutationErrorText = useMemo(() => {
    const e = createMutation.error ?? abortMutation.error;
    if (!e) return null;
    let formatted: string;
    try {
      formatted = formatApiError(e);
    } catch {
      formatted = toErrorMessage(e);
    }
    if (formatted === 'Unexpected error') {
      const alt = toErrorMessage(e);
      formatted = alt;
    }
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [createMutation.error, abortMutation.error, t]);

  const error = mutationErrorText ?? queryErrorText;
  const sessions = data ?? [];
  const loading = isLoading && !data;

  const reload = useCallback(() => {
    createMutation.reset();
    abortMutation.reset();
    void queryClient.invalidateQueries({ queryKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, queryKey]);

  const create = useCallback(
    async (title?: string) => {
      try {
        return await createMutation.mutateAsync(title);
      } catch {
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [createMutation.mutateAsync],
  );

  const abort = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        await abortMutation.mutateAsync(id);
      } catch {
        // Error surfaces via the `error` memo (mutationErrorText).
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [abortMutation.mutateAsync],
  );

  return {
    sessions,
    loading,
    error,
    isEmpty: !loading && !error && sessions.length === 0,
    reload,
    create,
    creating: createMutation.isPending,
    abort,
    abortingId: abortMutation.isPending ? (abortMutation.variables ?? null) : null,
  };
}
