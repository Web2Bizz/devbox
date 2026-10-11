'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import type { NpmPackageItem } from '../lib/types';
import { useI18n } from '../i18n';

export interface UseNpmResult {
  packages: NpmPackageItem[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  reload: () => void;
}

/**
 * Live npm status through the backend (live reachability only).
 *
 * v1 shape: one live-status probe mapped to a single-row list
 * (name/url/scope/status, no secrets — auth lives server-side,
 * never logged, never shipped to the browser).
 * Unreachable surfaces as `error` with retry — no silent mock payloads.
 * Flat /npm route (not nested).
 */
export function useNpm(): UseNpmResult {
  const { t } = useI18n();
  const [packages, setPackages] = useState<NpmPackageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .getNpmStatus()
      .then((data) => {
        if (cancelled) return;
        const url = typeof data?.url === 'string' ? data.url : '';
        const scope = typeof data?.scope === 'string' ? data.scope : '';
        setPackages([
          {
            id: 'default',
            name: scope || 'npm',
            url,
            scope,
            status: 'up',
          },
        ]);
      })
      .catch((e: unknown) => {
        if (cancelled || (e as Error)?.name === 'AbortError') return;
        try {
          const formatted = formatApiError(e);
          setPackages([]);
          if (e instanceof ApiClientError && e.status === 503) {
            setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
            return;
          }
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
        } catch {
          setPackages([]);
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
    packages,
    loading,
    error,
    isEmpty: !loading && !error && packages.length === 0,
    reload,
  };
}
