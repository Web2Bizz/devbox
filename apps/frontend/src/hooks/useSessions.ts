'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionInfo, SessionInterruptResult, SessionRunStatusMap } from '@rush-code/contracts';
import { ApiClientError } from '../api/client';
import {
  createSession,
  ensureSessionAuth,
  getSessionStatuses,
  interruptSession,
  listSessions,
  toErrorMessage,
} from '../api/sessions-client';
import { formatApiError } from '../lib/format-error';
import { SessionExpiredError } from '../lib/session-expired';
import { useI18n } from '../i18n';
import { sessionStatusQueryKey, sessionsQueryKey } from './query-keys';

export type UseSessionsResult = {
  sessions: SessionInfo[];
  /** sessionId → derived runtime status (GET /api/v1/sessions/status). */
  statusMap: SessionRunStatusMap;
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
  create: (title?: string) => Promise<SessionInfo | null>;
  creating: boolean;
  abort: (id: string) => Promise<void>;
  abortingId: string | null;
};

/**
 * Domain session query retry policy — the single source for every
 * /api/v1/sessions* React Query hook (useSessions/useSessionMessages).
 * No retry on terminal auth states (dead session / honest 401 — a retry
 * would only hammer /api/v1/sessions) and none on shape_mismatch (a contract
 * bug — a refetch cannot fix it); one retry otherwise (shared-client
 * contract).
 */
export function sessionsRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiClientError && error.status === 401) return false;
  if (error instanceof SessionExpiredError) return false;
  if (error instanceof ApiClientError && error.code === 'shape_mismatch') return false;
  return failureCount < 1;
}

/**
 * Shared error presentation — the hook contract: `queryFn`/`mutationFn`
 * throw the raw envelope, `formatApiError + t` mapping lives in `useMemo`
 * outside them (language switch neither refetches nor re-renders identity
 * consumers).
 */
function describeError(error: unknown, sessionExpired: string, unexpected: string): string {
  if (error instanceof SessionExpiredError) return sessionExpired;
  let formatted: string;
  try {
    formatted = formatApiError(error);
  } catch {
    formatted = toErrorMessage(error);
  }
  if (formatted === 'Unexpected error') {
    const alt = toErrorMessage(error);
    formatted = alt;
  }
  return formatted === 'Unexpected error' ? unexpected : formatted;
}

/**
 * Project-scoped sessions through the domain contract (`GET /api/v1/sessions`,
 * `GET /api/v1/sessions/status`, `POST /api/v1/sessions`, interrupt alias — see
 * api/sessions-client). Same loading/error/empty/reload contract as
 * useProjects:
 *
 * - Rows are the DOMAIN `SessionInfo` shape (real `directory` + `projectId`
 *   + nullable `title`/`model` + ISO `createdAt` + derived `status`) — no
 *   runner vocabulary, no client-side row mapping.
 * - `statusMap` is the working busy/idle source from the server (the old
 *   runner status route was never served by the current runtime, which made
 *   the running filter permanently empty); rows carry the same derived
 *   status, so the overlay `statusMap[id] ?? row.status` is a freshness
 *   merge of one source, not a fallback guess.
 * - Auth/C4: projectId REQUIRED on project pages — missing answers an
 *   honest 400 PROJECT_REQUIRED surfaced as the error state (never masked,
 *   never defaulted). `directory` is gone: the backend jails every route to
 *   the project content dir server-side.
 * - Cache: `sessionsQueryKey`/`sessionStatusQueryKey` (single source in
 *   query-keys.ts), staleTime 30s, placeholderData keeps previous rows
 *   during refetch, retry per `sessionsRetry`.
 */
export type UseSessionsOptions = {
  /** Rush Code project uuid — the C4 gate on every domain session route. */
  projectId?: string;
};

export function useSessions(options?: UseSessionsOptions): UseSessionsResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const projectId = options?.projectId;
  const queryKey = useMemo(() => sessionsQueryKey(projectId), [projectId]);
  const statusKey = useMemo(() => sessionStatusQueryKey(projectId), [projectId]);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (!projectId) {
        // Honest client-side gate: the domain route answers the same
        // PROJECT_REQUIRED 400 — fail before the network, same contract.
        throw new ApiClientError({
          code: 'PROJECT_REQUIRED',
          message: 'projectId is required — session routes are project-scoped',
          status: 400,
          correlationId: 'client',
        });
      }
      return listSessions(projectId, { signal });
    },
    staleTime: 30_000,
    // Keep previous data during refetch to avoid skeleton flash
    placeholderData: (prev) => prev,
    retry: sessionsRetry,
    enabled: true,
  });

  const { data: statusData } = useQuery({
    queryKey: statusKey,
    queryFn: ({ signal }) => {
      if (!projectId) return Promise.resolve({} as SessionRunStatusMap);
      return getSessionStatuses(projectId, { signal });
    },
    staleTime: 30_000,
    retry: sessionsRetry,
    enabled: Boolean(projectId),
  });

  const queryErrorText = useMemo(() => {
    if (!queryError) return null;
    return describeError(queryError, t.errors.sessionExpired, t.errors.unexpected);
  }, [queryError, t]);

  const createMutation = useMutation<SessionInfo, unknown, string | undefined>({
    mutationFn: async (title?: string): Promise<SessionInfo> => {
      if (!projectId) {
        throw new ApiClientError({
          code: 'PROJECT_REQUIRED',
          message: 'projectId is required — sessions are project-scoped',
          status: 400,
          correlationId: 'client',
        });
      }
      await ensureSessionAuth();
      return createSession({ projectId, ...(title !== undefined ? { title } : {}) });
    },
    onSuccess: (created) => {
      queryClient.setQueryData<SessionInfo[]>(queryKey, (old) =>
        old ? [created, ...old] : [created],
      );
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: statusKey });
    },
  });

  // Interrupt rides the domain route (POST /api/v1/sessions/{id}/interrupt);
  // {interrupted:false} (idle no-op) is an honest success, not an error.
  const abortMutation = useMutation<SessionInterruptResult, unknown, string>({
    mutationFn: async (id: string): Promise<SessionInterruptResult> => {
      if (!projectId) {
        throw new ApiClientError({
          code: 'PROJECT_REQUIRED',
          message: 'projectId is required — sessions are project-scoped',
          status: 400,
          correlationId: 'client',
        });
      }
      await ensureSessionAuth();
      return interruptSession(projectId, id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: statusKey });
    },
  });

  const mutationErrorText = useMemo(() => {
    const e = createMutation.error ?? abortMutation.error;
    if (!e) return null;
    return describeError(e, t.errors.sessionExpired, t.errors.unexpected);
  }, [createMutation.error, abortMutation.error, t]);

  const error = mutationErrorText ?? queryErrorText;
  const sessions = data ?? [];
  const statusMap = statusData ?? {};
  const loading = isLoading && !data;

  const reload = useCallback(() => {
    createMutation.reset();
    abortMutation.reset();
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: statusKey });
  }, [queryClient, queryKey, statusKey]);

  const create = useCallback(
    async (title?: string) => {
      try {
        return await createMutation.mutateAsync(title);
      } catch {
        return null;
      }
    },
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
    [abortMutation.mutateAsync],
  );

  return {
    sessions,
    statusMap,
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
