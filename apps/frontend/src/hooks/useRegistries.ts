'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import type { RegistryItem } from '../lib/types';
import { useI18n } from '../i18n';

export interface UseRegistriesResult {
  registries: RegistryItem[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
}

/**
 * Live registry catalog through the backend proxy
 * (`GET /api/v1/registry/catalog` → `{ repositories }`, live
 * Docker Registry /v2/_catalog only).
 *
 * v1 shape: one live-catalog proxy + a local list of several registries
 * in the frontend (name/url/status, no secrets — auth lives server-side
 * in DOCKER_REGISTRY_* env, never logged, never shipped to the browser).
 * A 503 (unconfigured/unreachable) surfaces as `error` with retry —
 * no silent mock payloads. `[id]` detail route is deferred.
 */
export function useRegistries(): UseRegistriesResult {
  const { t } = useI18n();
  const [registries, setRegistries] = useState<RegistryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .getRegistryCatalog()
      .then((data) => {
        if (cancelled) return;
        const repos = Array.isArray(data?.repositories) ? data.repositories : [];
        setRegistries([
          {
            id: 'default',
            name: 'default',
            url: '',
            status: 'up',
            repositories: repos,
          },
        ]);
      })
      .catch((e: unknown) => {
        if (cancelled || (e as Error)?.name === 'AbortError') return;
        try {
          const formatted = formatApiError(e);
          setRegistries([]);
          if (e instanceof ApiClientError && e.status === 503) {
            setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
            return;
          }
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
        } catch {
          setRegistries([]);
          setError(t.errors.unexpected);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [nonce, t]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    registries,
    loading,
    error,
    isEmpty: !loading && !error && registries.length === 0,
    reload,
  };
}
