'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { setSession, signOutAndRedirect } from '../lib/auth-store';
import type { MockUser } from '../lib/mocks/auth';
import { useI18n } from '../i18n';

export type UseLoginResult = {
  user: MockUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  retry: () => void;
};

/**
 * Real login hook — POST /api/v1/auth/login (contract unchanged:
 * UseLoginResult shape is frozen, only the body swapped mock → api).
 * Tokens land in lib/auth-store (memory + localStorage); the refresh
 * httpOnly cookie is set by the backend response.
 */
export function useLogin(): UseLoginResult {
  const { t } = useI18n();
  const router = useRouter();
  const [user, setUser] = useState<MockUser | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const session = await api.login({ email: email.trim(), password });
      setSession(session);
      setUser({
        id: session.user.id,
        email: session.user.email,
        name: `${session.user.firstName} ${session.user.lastName}`.trim(),
      });
      return true;
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'invalid_credentials') {
        setError(t.validation.invalidCredentials);
      } else {
        const formatted = formatApiError(e);
        setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [t]);

  const logout = useCallback(() => {
    // Единый путь sign-out: revoke + clear + снос маркера + сброс кэша + /login.
    setUser(null);
    setError(null);
    void signOutAndRedirect({ router });
  }, [router]);

  const retry = useCallback(() => {
    setError(null);
  }, []);

  return { user, loading, error, login, logout, retry };
}
