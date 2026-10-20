'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, api } from '../api/client';
import type { OpencodeUsage } from '@devbox/contracts';
import { getValidAccessToken, refreshAccessToken } from '../lib/auth-store';
import { USAGE_QUERY_KEY } from './query-keys';
import { useI18n } from '../i18n';
import {
  SessionExpiredError,
  isMissingKeyError,
  isRejectedKeyError,
  mapUsageStatus,
  type UsageStatus,
} from '../features/usage/usage-status';

export type UseUsageResult = {
  usage: OpencodeUsage | null;
  loading: boolean;
  error: string | null;
  status: UsageStatus;
  diagnostic: string | null;
  shortId: string;
  noKey: boolean;
  noKeyMissing: boolean;
  noKeyInvalid: boolean;
  upstreamDown: boolean;
  upstreamUnavailable: boolean;
  reload: () => void;
};

async function fetchUsage(): Promise<OpencodeUsage> {
  const token = await getValidAccessToken();
  if (!token) throw new SessionExpiredError();
  try {
    return await api.getUsage(token);
  } catch (e) {
    if (isMissingKeyError(e) || isRejectedKeyError(e)) throw e;
    if (e instanceof ApiClientError && e.status === 401) {
      const retryToken = await refreshAccessToken();
      if (!retryToken) throw new SessionExpiredError();
      return await api.getUsage(retryToken);
    }
    throw e;
  }
}

function usageRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof SessionExpiredError) return false;
  if (error instanceof ApiClientError) {
    if (error.status === 404 && error.code === 'opencode_key_missing') return false;
    if (error.status === 401) return false;
  }
  return failureCount < 1;
}

export function useUsage(): UseUsageResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: USAGE_QUERY_KEY,
    queryFn: fetchUsage,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
    retry: usageRetry,
  });

  const status = useMemo<UsageStatus>(
    () =>
      mapUsageStatus(queryError, {
        sessionExpired: t.errors.sessionExpired,
        unexpected: t.errors.unexpected,
      }),
    [queryError, t],
  );

  const noKeyMissing = status.kind === 'missing-key';
  const noKeyInvalid = status.kind === 'invalid-key';
  const upstreamDown = status.kind === 'failed' && status.upstream;
  const error =
    status.kind === 'session-expired' || status.kind === 'failed' ? status.message : null;
  const diagnostic = status.kind === 'failed' ? status.diagnostic : null;
  const shortId = status.kind === 'failed' ? status.shortId : '';

  const usage =
    noKeyMissing || noKeyInvalid || upstreamDown ? null : (data ?? null);

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: USAGE_QUERY_KEY });
  }, [queryClient]);

  const loading = isLoading && !data;

  return {
    usage,
    loading,
    error,
    status,
    diagnostic,
    shortId,
    noKey: noKeyMissing || noKeyInvalid,
    noKeyMissing,
    noKeyInvalid,
    upstreamDown,
    upstreamUnavailable: upstreamDown,
    reload,
  };
}
