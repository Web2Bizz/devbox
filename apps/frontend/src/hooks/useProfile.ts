'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken, refreshAccessToken, signOutAndRedirect } from '../lib/auth-store';
import type { Profile } from '../lib/types';
import { useI18n } from '../i18n';

export interface UseProfileResult {
  profile: Profile | null;
  loading: boolean;
  error: string | null;
  saved: boolean;
  saving: boolean;
  update: (patch: Pick<Profile, 'name' | 'email'>) => Promise<boolean>;
  reload: () => void;
  dismiss: () => void;
}

function toProfile(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: string;
  limits?: Profile['limits'];
}): Profile {
  return {
    id: user.id,
    name: `${user.firstName} ${user.lastName}`.trim(),
    email: user.email,
    role: 'Owner',
    createdAt: user.createdAt,
    ...(user.limits ? { limits: user.limits } : {}),
  };
}

/** Splits the single `name` field back into first/last for PATCH /auth/me. */
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') || (parts[0] ?? '') };
}

/**
 * Real profile hook — GET/PATCH /api/v1/auth/me (contract unchanged:
 * UseProfileResult shape is frozen, only the body swapped mock → api).
 * 401 → one silent refresh retry, then the session-expired message.
 */
export function useProfile(): UseProfileResult {
  const { t } = useI18n();
  // Стабильная ссылка на router: next/navigation гарантирует стабильность,
  // но тестовые стабы отдают новый объект каждый рендер — через ref эффект
  // не уходит в бесконечный рефакт, deps эффекта не меняются ([nonce, t]).
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        let token = await getValidAccessToken();
        if (!token) {
          // Сессия мертва (оба токена протухли): единый sign-out + /login.
          void signOutAndRedirect({ router: routerRef.current });
          if (!cancelled) setError(t.errors.sessionExpired);
          return;
        }
        try {
          const user = await api.me(token);
          if (!cancelled) setProfile(toProfile(user));
        } catch (e) {
          if (e instanceof ApiClientError && e.status === 401) {
            token = await refreshAccessToken();
            if (!token) {
              void signOutAndRedirect({ router: routerRef.current });
              if (!cancelled) setError(t.errors.sessionExpired);
              return;
            }
            const user = await api.me(token);
            if (!cancelled) setProfile(toProfile(user));
          } else {
            throw e;
          }
        }
      } catch (e) {
        if (!cancelled) {
          const formatted = formatApiError(e);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce, t]);

  const update = useCallback(
    async (patch: Pick<Profile, 'name' | 'email'>) => {
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        if (!patch.name.trim()) throw new Error(t.validation.nameRequired);
        if (!patch.email.includes('@')) throw new Error(t.validation.invalidEmail);
        const token = await getValidAccessToken();
        if (!token) {
          void signOutAndRedirect({ router: routerRef.current });
          setError(t.errors.sessionExpired);
          return false;
        }
        const { firstName, lastName } = splitName(patch.name);
        const user = await api.updateMe(token, { firstName, lastName });
        setProfile(toProfile(user));
        setSaved(true);
        return true;
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 401) {
          void signOutAndRedirect({ router: routerRef.current });
          setError(t.errors.sessionExpired);
        } else {
          const formatted = formatApiError(e);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
        }
        return false;
      } finally {
        setSaving(false);
      }
    },
    [t],
  );

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const dismiss = useCallback(() => {
    setError(null);
    setSaved(false);
  }, []);

  return { profile, loading, error, saved, saving, update, reload, dismiss };
}

/**
 * Header-only identity hook — same GET /api/v1/auth/me fetch (one silent
 * 401 refresh retry) as useProfile, but with NO useI18n subscription:
 * locale switches neither refetch /auth/me nor re-render
 * HeaderProfileDropdown (its userMenu labels are a mount snapshot there).
 * No translated error strings — the header only renders skeleton /
 * unauthorized states; useProfile (with live `t`) stays the single source
 * for the /profile page, whose error translations are untouched.
 */
export function useHeaderProfile(): { profile: Profile | null; loading: boolean } {
  // Стабильная ссылка на router — см. комментарий в useProfile.
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        let token = await getValidAccessToken();
        if (!token) {
          // Сессия мертва (оба токена протухли): единый sign-out + /login.
          void signOutAndRedirect({ router: routerRef.current });
          return;
        }
        try {
          const user = await api.me(token);
          if (!cancelled) setProfile(toProfile(user));
        } catch (e) {
          if (e instanceof ApiClientError && e.status === 401) {
            token = await refreshAccessToken();
            if (!token) {
              void signOutAndRedirect({ router: routerRef.current });
              return;
            }
            const user = await api.me(token);
            if (!cancelled) setProfile(toProfile(user));
          }
          // Non-401: у шапки нет error-UI — остаёмся в unauthorized (login CTA).
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { profile, loading };
}
