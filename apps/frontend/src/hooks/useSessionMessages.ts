'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionMessage } from '@rush-code/contracts';
import { ApiClientError } from '../api/client';
import { listSessionMessages, sendSessionMessage, toErrorMessage } from '../api/sessions-client';
import { formatApiError } from '../lib/format-error';
import { SessionExpiredError } from '../lib/session-expired';
import { useI18n } from '../i18n';
import { sessionMessagesQueryKey } from './query-keys';

export type UseSessionMessagesResult = {
  messages: SessionMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  isEmpty: boolean;
  send: (text: string) => Promise<void>;
  reload: () => void;
};

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
 * Session thread through the domain contract (GET/POST
 * `/api/sessions/{id}/messages`) — React Query data hook (rows are the
 * normalized `SessionMessage` projection: id/type/createdAt/text|null,
 * boundary-parsed in api/client). The send() queues the prompt and the
 * assistant answer streams over /api/sessions/events (useSessionEvents),
 * so the mutation only invalidates the thread; live text does not come
 * from this hook.
 *
 * `projectId` is the C4 gate: without it no request goes out and the
 * honest PROJECT_REQUIRED error is surfaced (never masked). No live
 * callers yet (the chat feature composes useChat); the signature stays
 * `(sessionId, projectId)` so future project tabs pick it up without
 * reshaping.
 */
export function useSessionMessages(
  sessionId: string | null,
  projectId?: string,
): UseSessionMessagesResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => sessionMessagesQueryKey(sessionId, projectId),
    [sessionId, projectId],
  );

  const { data, isLoading, error: queryError } = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (!sessionId || !projectId) {
        throw new ApiClientError({
          code: 'PROJECT_REQUIRED',
          message: 'sessionId and projectId are required — threads are project-scoped',
          status: 400,
          correlationId: 'client',
        });
      }
      return listSessionMessages(projectId, sessionId, { signal });
    },
    enabled: Boolean(sessionId && projectId),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    retry: 1,
  });

  const queryErrorText = useMemo(() => {
    if (!queryError) return null;
    return describeError(queryError, t.errors.sessionExpired, t.errors.unexpected);
  }, [queryError, t]);

  const sendMutation = useMutation<SessionMessage, unknown, string>({
    mutationFn: (text: string) => {
      if (!sessionId || !projectId) {
        throw new ApiClientError({
          code: 'PROJECT_REQUIRED',
          message: 'sessionId and projectId are required — threads are project-scoped',
          status: 400,
          correlationId: 'client',
        });
      }
      return sendSessionMessage(projectId, sessionId, text);
    },
    onSuccess: (receipt) => {
      // The queued user row is known already — patch it in, then let the
      // server be the truth on the next settle (assistant part arrives
      // through the events stream, not this response).
      queryClient.setQueryData<SessionMessage[]>(queryKey, (old) =>
        old ? [...old, receipt] : [receipt],
      );
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const mutationErrorText = useMemo(() => {
    if (!sendMutation.error) return null;
    return describeError(sendMutation.error, t.errors.sessionExpired, t.errors.unexpected);
  }, [sendMutation.error, t]);

  const error = mutationErrorText ?? queryErrorText;
  const messages = data ?? [];
  const loading = isLoading && !data;

  const reload = useCallback(() => {
    sendMutation.reset();
    void queryClient.invalidateQueries({ queryKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, queryKey]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      try {
        await sendMutation.mutateAsync(text);
      } catch {
        // Error surfaces via the `error` memo (mutationErrorText).
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendMutation.mutateAsync],
  );

  return {
    messages,
    loading,
    sending: sendMutation.isPending,
    error,
    isEmpty: !loading && !error && messages.length === 0,
    send,
    reload,
  };
}
