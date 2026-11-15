'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { forkSession } from '../api/sessions-client';
import { sessionMessagesQueryKey, sessionsQueryKey } from './query-keys';

/**
 * Fork a session at an optional message boundary. React Query mutation:
 * `before` omitted → the whole thread is copied. On success both the project
 * session list and the (new) forked thread are invalidated so a later open
 * sees the copied rows — no local optimistic copy of server-owned history.
 */
export function useForkSession(sessionId: string | null, projectId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (before?: string) => {
      if (!sessionId) return Promise.reject(new Error('session is required'));
      if (!projectId) return Promise.reject(new Error('project is required'));
      return forkSession(projectId, sessionId, before);
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey(projectId) });
      void queryClient.invalidateQueries({
        queryKey: sessionMessagesQueryKey(result.session.id, projectId),
      });
    },
  });
}
