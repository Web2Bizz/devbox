'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateRunRequest, RunInfo, RunInfoList, RunStreamFrame } from '@rush-code/contracts';
import { ApiClientError } from '../api/client';
import { toErrorMessage } from '../api/sessions-client';
import { createRun, getRun, listRuns, runEventStream } from '../api/runs-client';
import { sessionsRetry } from './useSessions';
import { runQueryKey, runsQueryKey } from './query-keys';

export type UseRunsResult = {
  runs: RunInfoList;
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
};

/**
 * Project-scoped run list (`GET /api/v1/runs?projectId=…`).
 *
 * Same contract as useSessions: the queryFn throws the raw ApiClientError
 * (a missing projectId answers the honest client-side PROJECT_REQUIRED gate,
 * never a default project), formatting lives in a `useMemo`, and `reload`
 * invalidates the shared key. `placeholderData` keeps previous rows during
 * refetch.
 */
export function useRuns(projectId?: string): UseRunsResult {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => runsQueryKey(projectId), [projectId]);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (!projectId) {
        // Honest client-side gate: the domain route answers the same
        // PROJECT_REQUIRED 400 — fail before the network, same contract.
        throw new ApiClientError({
          code: 'PROJECT_REQUIRED',
          message: 'projectId is required — run routes are project-scoped',
          status: 400,
          correlationId: 'client',
        });
      }
      return listRuns(projectId, { signal });
    },
    enabled: Boolean(projectId),
    staleTime: 30_000,
    retry: sessionsRetry,
    // Keep previous data during refetch to avoid skeleton flash
    placeholderData: (prev) => prev,
  });

  const error = useMemo(() => (queryError ? toErrorMessage(queryError) : null), [queryError]);

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const runs = data ?? [];
  const loading = isLoading && !data;

  return { runs, loading, error, isEmpty: !loading && runs.length === 0, reload };
}

export type UseRunResult = {
  run: RunInfo | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

/** One run row (`GET /api/v1/runs/{id}`) — same loading/error/reload contract. */
export function useRun(runId: string | null): UseRunResult {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => runQueryKey(runId), [runId]);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (!runId) {
        throw new ApiClientError({
          code: 'RUN_REQUIRED',
          message: 'runId is required — a run row is run-scoped',
          status: 400,
          correlationId: 'client',
        });
      }
      return getRun(runId, { signal });
    },
    enabled: Boolean(runId),
    staleTime: 15_000,
    retry: sessionsRetry,
  });

  const error = useMemo(() => (queryError ? toErrorMessage(queryError) : null), [queryError]);

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const run = data ?? null;
  const loading = isLoading && !data;

  return { run, loading, error, reload };
}

export type UseCreateRunResult = {
  create: (body: CreateRunRequest) => Promise<RunInfo | null>;
  creating: boolean;
  error: string | null;
};

/**
 * `POST /api/v1/runs` — creates a run and seeds the single-run cache entry.
 * `create` mirrors useSessions.create: it never throws into the UI and
 * resolves null on failure, while the error surfaces through `error`.
 */
export function useCreateRun(projectId?: string): UseCreateRunResult {
  const queryClient = useQueryClient();
  const mutation = useMutation<RunInfo, unknown, CreateRunRequest>({
    mutationFn: createRun,
    onSuccess: (run) => {
      queryClient.setQueryData(runQueryKey(run.id), run);
      void queryClient.invalidateQueries({ queryKey: runsQueryKey(projectId ?? run.projectId) });
    },
  });

  const create = useCallback(
    async (body: CreateRunRequest) => {
      try {
        return await mutation.mutateAsync(body);
      } catch {
        return null;
      }
    },
    [mutation],
  );

  const error = useMemo(
    () => (mutation.error ? toErrorMessage(mutation.error) : null),
    [mutation.error],
  );

  return { create, creating: mutation.isPending, error };
}

export type RunStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

export type UseRunEventsResult = {
  frames: RunStreamFrame[];
  status: RunStreamStatus;
  error: string | null;
  stop: () => void;
  reconnect: () => void;
};

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 20;
}

/**
 * Live run journal through the domain SSE route
 * (`GET /api/v1/runs/{id}/events?cursor=…`, api/runs-client).
 *
 * Deliberately `useEffect`, NOT React Query: a long-lived streaming
 * subscription with self-healing reconnects is the AGENTS.md streaming
 * exception (same rationale as useChat/useSessionEvents).
 *
 * - `cursorRef` carries the last delivered frame seq; a reconnect redials
 *   with that cursor so no journal frame is lost across a break.
 * - Frames are deduped by `id` (a redial may replay the boundary frame)
 *   and scoped by the hoisted `run` id.
 * - Exponential backoff reconnect (1s → 15s ceiling) on clean stream end
 *   or transport failure; `stoppedRef` guards late frames after stop().
 * - `run.step.committed` invalidates the run row + list caches so the UI
 *   picks up the committed step.
 */
export function useRunEvents(runId: string | null, initialCursor = 0): UseRunEventsResult {
  const queryClient = useQueryClient();
  const [frames, setFrames] = useState<RunStreamFrame[]>([]);
  const [status, setStatus] = useState<RunStreamStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const cursorRef = useRef(initialCursor);
  const ctrlRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);

  // Reset the journal when the bound run (or its starting cursor) changes.
  // Deliberate useEffect: streaming/SSE exception (see the hook doc above).
  useEffect(() => {
    setFrames([]);
    cursorRef.current = initialCursor;
    setError(null);
    setStatus('connecting');
    stoppedRef.current = false;
  }, [runId, initialCursor]);

  // Live subscription. Deliberate useEffect, not React Query: streaming/SSE
  // is the AGENTS.md exception (useChat/useSessionEvents precedent).
  useEffect(() => {
    if (!runId) {
      // Defensive path (every caller binds a run): surfaced honestly, never
      // an anonymous global stream.
      setStatus('error');
      setError('runId is required — run events are run-scoped');
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const scheduleReconnect = () => {
      if (disposed || stoppedRef.current) return;
      attempt += 1;
      const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      setStatus('reconnecting');
      timer = setTimeout(() => {
        if (!disposed) void connect();
      }, delay);
    };

    const connect = async () => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setStatus('live');
      setError(null);
      try {
        for await (const frame of runEventStream(runId, cursorRef.current, ctrl.signal)) {
          if (disposed || stoppedRef.current) return;
          if (frame.run !== runId) continue;
          const seq = Number(frame.id);
          if (Number.isFinite(seq)) cursorRef.current = Math.max(cursorRef.current, seq);
          setFrames((prev) =>
            prev.some((p) => p.id === frame.id) ? prev : [...prev, frame],
          );
          if (frame.type === 'run.step.committed') {
            void queryClient.invalidateQueries({ queryKey: runQueryKey(runId) });
            // Prefix invalidation: every runsQueryKey(projectId) entry, not just 'none'.
            void queryClient.invalidateQueries({ queryKey: ['runs'] });
          }
        }
        // Clean upstream end → redial with backoff so the stream self-heals.
        if (!disposed) scheduleReconnect();
      } catch (e: unknown) {
        if (disposed || isAbortError(e) || stoppedRef.current) return;
        setError(toErrorMessage(e));
        setStatus('reconnecting');
        scheduleReconnect();
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ctrlRef.current?.abort();
    };
  }, [runId, nonce, queryClient]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    setStatus('error');
    ctrlRef.current?.abort();
  }, []);

  const reconnect = useCallback(() => {
    stoppedRef.current = false;
    setNonce((n) => n + 1);
  }, []);

  return { frames, status, error, stop, reconnect };
}
