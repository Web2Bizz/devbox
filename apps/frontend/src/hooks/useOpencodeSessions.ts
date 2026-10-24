'use client';

import { useCallback, useEffect, useState } from 'react';
import { opencode, toErrorMessage } from '../api/opencode-client';
import type { Session } from '@opencode-ai/sdk/client';
import { useI18n } from '../i18n';

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
 * Live session list through the backend reverse-proxy
 * (`<NEXT_PUBLIC_API_URL>/api/opencode`, same sdk as the backend).
 * Same loading/error/empty/reload contract as useProjects.
 *
 * Scoping: pass `directory` (opencode working directory) to forward
 * `?directory=` on list/create/abort — the backend mirrors it 1:1 to the
 * upstream sdk query. Rush Code `projectId` (prj-*) is UI-only here; the
 * server-side projectId → directory mapping lands later, so callers pass
 * `directory` explicitly when known (tabs) and omit it for the full list.
 */
export function useOpencodeSessions(directory?: string): UseOpencodeSessionsResult {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [abortingId, setAbortingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    opencode.session
      .list(directory ? { query: { directory }, signal: ctrl.signal } : { signal: ctrl.signal })
      .then((res) => {
        if (cancelled) return;
        if (res.error !== undefined || res.data === undefined) {
          const formatted = toErrorMessage(res.error);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
          return;
        }
        setSessions(res.data);
      })
      .catch((e: unknown) => {
        if (cancelled || (e as Error)?.name === 'AbortError') return;
        const formatted = toErrorMessage(e);
        setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [directory, nonce, t]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const create = useCallback(
    async (title?: string) => {
      setCreating(true);
      setError(null);
      try {
        const res = await opencode.session.create(
          directory ? { body: { title }, query: { directory } } : { body: { title } },
        );
        if (res.error !== undefined || res.data === undefined) {
          const formatted = toErrorMessage(res.error);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
          return null;
        }
        const created = res.data as Session;
        setSessions((prev) => [created, ...prev]);
        return created;
      } catch (e: unknown) {
        const formatted = toErrorMessage(e);
        setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
        return null;
      } finally {
        setCreating(false);
      }
    },
    [directory, t],
  );

  const abort = useCallback(
    async (id: string) => {
      if (!id) return;
      setAbortingId(id);
      setError(null);
      try {
        const res = await opencode.session.abort(
          directory ? { path: { id }, query: { directory } } : { path: { id } },
        );
        if (res.error !== undefined) {
          const formatted = toErrorMessage(res.error);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
          return;
        }
        setNonce((n) => n + 1);
      } catch (e: unknown) {
        if ((e as Error)?.name === 'AbortError') return;
        const formatted = toErrorMessage(e);
        setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
      } finally {
        setAbortingId(null);
      }
    },
    [directory, t],
  );

  return {
    sessions,
    loading,
    error,
    isEmpty: !loading && !error && sessions.length === 0,
    reload,
    create,
    creating,
    abort,
    abortingId,
  };
}
