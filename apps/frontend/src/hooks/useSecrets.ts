'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiClientError } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { MOCK_SECRETS, MOCK_SECRET_VALUES } from '../lib/mocks/secrets';
import type { SecretItem } from '../lib/types';
import { useI18n } from '../i18n';

export interface UseSecretsResult {
  secrets: SecretItem[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  revealed: Record<string, string>;
  copiedId: string | null;
  reveal: (id: string) => void;
  hide: (id: string) => void;
  copy: (id: string) => Promise<void>;
  remove: (id: string) => void;
  reload: () => void;
}

/**
 * Mock secrets hook: list + reveal/hide + copy + delete (local only).
 * TODO REAL-API: list via GET /api/v1/secrets, reveal via POST
 * /api/v1/secrets/:id/reveal, delete via DELETE; map ApiClientError.
 */
export function useSecrets(): UseSecretsResult {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      if (cancelled) return;
      try {
        setSecrets(MOCK_SECRETS);
        setRevealed({});
      } catch (e) {
        const formatted = formatApiError(e);
        setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nonce, t]);

  const reveal = useCallback((id: string) => {
    const value = MOCK_SECRET_VALUES[id];
    if (!value) {
      setError(
        formatApiError(
          new ApiClientError({
            code: 'not_found',
            message: t.secrets.notFound(id),
            status: 404,
            correlationId: 'mock-correlation-id',
          }),
        ),
      );
      return;
    }
    setRevealed((prev) => ({ ...prev, [id]: value }));
  }, [t]);

  const hide = useCallback((id: string) => {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const copy = useCallback(async (id: string) => {
    const value = revealed[id] ?? MOCK_SECRET_VALUES[id] ?? '';
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch (e) {
      const formatted = formatApiError(e);
      setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
    }
  }, [revealed, t]);

  const remove = useCallback((id: string) => {
    setSecrets((prev) => prev.filter((s) => s.id !== id));
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    secrets,
    loading,
    error,
    isEmpty: !loading && !error && secrets.length === 0,
    revealed,
    copiedId,
    reveal,
    hide,
    copy,
    remove,
    reload,
  };
}
