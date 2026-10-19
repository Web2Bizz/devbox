'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiClientError, api } from '../api/client';
import type { OpencodeUsage } from '../api/types';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken, refreshAccessToken, signOutAndRedirect } from '../lib/auth-store';
import { useI18n } from '../i18n';

export interface UseUsageResult {
  usage: OpencodeUsage | null;
  loading: boolean;
  error: string | null;
  /**
   * True when the backend answers 404 opencode_key_missing (no stored key).
   * User-side state — the Limits section renders the inline Add API key
   * CTA (no ErrorBoundary, no unavailable wording).
   */
  noKey: boolean;
  /** 404 opencode_key_missing — same as noKey (explicit 4xx branch). */
  noKeyMissing: boolean;
  /**
   * True when the backend answers 401 opencode_key_invalid (the stored key
   * was rejected upstream). User-side state — inline Add API key CTA like
   * the missing-key branch, never a session refresh loop.
   */
  noKeyInvalid: boolean;
  /**
   * True when the upstream is down or throttled: any 5xx (502/503/504…),
   * 429, or a network/timeout failure talking to the backend. Critical
   * state — the Limits section renders the section-local ErrorState
   * (destructive Alert + Retry), no inline unavailable texts.
   */
  upstreamDown: boolean;
  /**
   * Deprecated alias of upstreamDown (kept for compat, prefer upstreamDown).
   */
  upstreamUnavailable: boolean;
  reload: () => void;
}

/** 401 carrying the rejected-key code (user-side) vs a session 401 (refresh). */
function isRejectedKeyError(e: unknown): boolean {
  return e instanceof ApiClientError && e.status === 401 && e.code === 'opencode_key_invalid';
}

/** 404 carrying the missing-key code (user-side, never an error). */
function isMissingKeyError(e: unknown): boolean {
  return e instanceof ApiClientError && e.status === 404 && e.code === 'opencode_key_missing';
}

/**
 * Critical (downstream-of-the-user) failure: throttled, upstream 5xx, or the
 * request never reached the backend (network/timeout, status 0).
 */
function isUpstreamDownError(e: unknown): boolean {
  if (!(e instanceof ApiClientError)) return false;
  return e.status === 429 || e.status >= 500 || e.status === 0;
}

/**
 * Live usage hook — GET /api/v1/usage (contract: { updatedAt }
 * + optional legacy { balance, usage } + additive rolling/daily/weekly/monthly
 * { used, limit } breakdown; Zen Go percent is exposed as { used: percent, limit: 100 }).
 * Session 401 → one silent refresh retry, then the session-expired message.
 * 404 opencode_key_missing / 401 opencode_key_invalid → 4xx user branches
 * (usage null, error null — never fake 0% bars, never ErrorBoundary).
 * 429 / 5xx / network → upstreamDown + error for the section ErrorState.
 * Percentages are derived by the caller ONLY from real used/limit pairs;
 * derivation from the `usage` total is forbidden.
 */
export function useUsage(): UseUsageResult {
  const { t } = useI18n();
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [usage, setUsage] = useState<OpencodeUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noKeyMissing, setNoKeyMissing] = useState(false);
  const [noKeyInvalid, setNoKeyInvalid] = useState(false);
  const [upstreamDown, setUpstreamDown] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNoKeyMissing(false);
    setNoKeyInvalid(false);
    setUpstreamDown(false);
    (async () => {
      try {
        let token = await getValidAccessToken();
        if (!token) {
          void signOutAndRedirect({ router: routerRef.current });
          if (!cancelled) setError(t.errors.sessionExpired);
          return;
        }
        const fetchUsage = (accessToken: string) => api.getUsage(accessToken);
        const applyUserBranch = (e: unknown): boolean => {
          if (isMissingKeyError(e)) {
            if (!cancelled) {
              setUsage(null);
              setNoKeyMissing(true);
              setNoKeyInvalid(false);
              setUpstreamDown(false);
              setError(null);
            }
            return true;
          }
          if (isRejectedKeyError(e)) {
            if (!cancelled) {
              setUsage(null);
              setNoKeyMissing(false);
              setNoKeyInvalid(true);
              setUpstreamDown(false);
              setError(null);
            }
            return true;
          }
          return false;
        };
        try {
          const data = await fetchUsage(token);
          if (!cancelled) {
            setUsage(data);
            setNoKeyMissing(false);
            setNoKeyInvalid(false);
          }
        } catch (e) {
          if (applyUserBranch(e)) return;
          if (e instanceof ApiClientError && e.status === 401) {
            token = await refreshAccessToken();
            if (!token) {
              void signOutAndRedirect({ router: routerRef.current });
              if (!cancelled) setError(t.errors.sessionExpired);
              return;
            }
            try {
              const data = await fetchUsage(token);
              if (!cancelled) {
                setUsage(data);
                setNoKeyMissing(false);
                setNoKeyInvalid(false);
              }
            } catch (retryErr) {
              if (applyUserBranch(retryErr)) return;
              throw retryErr;
            }
          } else {
            throw e;
          }
        }
      } catch (e) {
        if (!cancelled) {
          const formatted = formatApiError(e);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
          const down = isUpstreamDownError(e);
          setUpstreamDown(down);
          if (down) setUsage(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce, t]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const noKey = noKeyMissing || noKeyInvalid;
  return {
    usage,
    loading,
    error,
    noKey,
    noKeyMissing,
    noKeyInvalid,
    upstreamDown,
    upstreamUnavailable: upstreamDown,
    reload,
  };
}
