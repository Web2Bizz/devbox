'use client';

import { useCallback, useEffect, useState } from 'react';
import { opencode, toErrorMessage } from '../api/opencode-client';
import { formatApiError } from '../lib/format-error';
import type { AiProvider } from '../lib/types';
import { useI18n } from '../i18n';

export interface UseAiProvidersResult {
  providers: AiProvider[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  isEmpty: boolean;
  toggle: (id: string) => void;
  configure: (id: string) => void;
  reload: () => void;
  dismiss: () => void;
}

/**
 * Live provider list through the backend reverse-proxy
 * (`GET /api/opencode/config/providers`, same sdk 1.18.33 as the backend).
 * Toggle/configure stay local-only (no backend write endpoints yet);
 * keep loading/error/notice contract. A 503 (upstream down) surfaces as
 * `error` with retry — no silent mock payloads.
 */
export function useAiProviders(directory?: string): UseAiProvidersResult {
  const { t } = useI18n();
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    opencode.config
      .providers(directory ? { query: { directory }, signal: ctrl.signal } : { signal: ctrl.signal })
      .then((res) => {
        if (cancelled) return;
        if (res.error !== undefined || res.data === undefined) {
          const formatted = toErrorMessage(res.error);
          setProviders([]);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
          return;
        }
        const live = (res.data.providers ?? []).map((p) => ({
          id: p.id,
          name: p.name || p.id,
          description: `${p.source}${p.env?.length ? ` · ${p.env.join(', ')}` : ''}`,
          enabled: true,
          status: 'connected' as const,
          modelsCount: Object.keys(p.models ?? {}).length,
        }));
        setProviders(live);
      })
      .catch((e: unknown) => {
        if (cancelled || (e as Error)?.name === 'AbortError') return;
        try {
          const formatted = formatApiError(e);
          setProviders([]);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
        } catch {
          const formatted = toErrorMessage(e);
          setProviders([]);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [directory, nonce, t]);

  const toggle = useCallback((id: string) => {
    setNotice(null);
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)));
  }, []);

  const configure = useCallback((id: string) => {
    setNotice(null);
    setError(null);
    // Local-only until backend write endpoints exist (no POST/PATCH for
    // providers upstream yet) — flip the row on and surface the notice.
    const target = providers.find((p) => p.id === id);
    setProviders((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, enabled: true, status: 'connected' as const } : p,
      ),
    );
    setNotice(t.aiProviders.connectedNotice(target?.name ?? id));
  }, [providers, t]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const dismiss = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return {
    providers,
    loading,
    error,
    notice,
    isEmpty: !loading && !error && providers.length === 0,
    toggle,
    configure,
    reload,
    dismiss,
  };
}
