'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clearRevert, commitRevert, stageRevert } from '../api/sessions-client';
import { sessionMessagesQueryKey } from './query-keys';

/**
 * Staged revert over the domain contract: `stage` restores the boundary
 * turn's snapshot and answers the produced diff; `clear` puts the files
 * back; `commit` keeps them. The thread cache is invalidated after every
 * settled action (the backend is the truth — no optimistic file state).
 */
export function useRevert(sessionId: string | null, projectId?: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: sessionMessagesQueryKey(sessionId, projectId) });
  };

  const stage = useMutation({
    mutationFn: (messageID: string) => {
      if (!sessionId) return Promise.reject(new Error('session is required'));
      if (!projectId) return Promise.reject(new Error('project is required'));
      return stageRevert(projectId, sessionId, messageID);
    },
    onSuccess: refresh,
  });

  const clear = useMutation({
    mutationFn: () => {
      if (!sessionId) return Promise.reject(new Error('session is required'));
      if (!projectId) return Promise.reject(new Error('project is required'));
      return clearRevert(projectId, sessionId);
    },
    onSuccess: refresh,
  });

  const commit = useMutation({
    mutationFn: () => {
      if (!sessionId) return Promise.reject(new Error('session is required'));
      if (!projectId) return Promise.reject(new Error('project is required'));
      return commitRevert(projectId, sessionId);
    },
    onSuccess: refresh,
  });

  return { stage, clear, commit };
}
