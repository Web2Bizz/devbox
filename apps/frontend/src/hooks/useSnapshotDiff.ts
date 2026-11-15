'use client';

import { useQuery } from '@tanstack/react-query';
import { snapshotDiff } from '../api/sessions-client';
import { sessionSnapshotDiffQueryKey } from './query-keys';

/**
 * Per-file diff between two captured session snapshots (git tree ids from
 * RevertInfo.snapshot). Disabled until both boundaries are known — no request
 * with an empty pair, no client-side snapshot arithmetic.
 */
export function useSnapshotDiff(
  sessionId: string | null,
  projectId: string | undefined,
  from: string | null,
  to: string | null,
  context?: number,
) {
  return useQuery({
    queryKey: sessionSnapshotDiffQueryKey(sessionId, from, to),
    queryFn: ({ signal }) => {
      if (!sessionId || !projectId || !from || !to) {
        throw new Error('session, project and both snapshots are required');
      }
      return snapshotDiff(projectId, sessionId, from, to, context);
    },
    enabled: Boolean(sessionId && projectId && from && to),
  });
}
