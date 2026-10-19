'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthorizedUserProfile, UnauthorizedUserProfile } from '@web2bizz/ui/widgets';
import { signOutAndRedirect } from '../../lib/auth-store';
import { useHeaderProfile } from '../../hooks/useProfile';
import { LOCALE_COOKIE, isLocale } from '../../i18n';
import { en } from '../../i18n/dictionaries/en';
import { ru } from '../../i18n/dictionaries/ru';
import type { Dictionary } from '../../i18n/dictionaries/types';

/**
 * Header user menu — pure kit (@web2bizz/ui 0.26.0 `widgets` entry).
 * Thin data adapter (<30 lines): useHeaderProfile() → kit `user`,
 * userMenu snapshot en/ru → kit `labels`, sign-out/login →
 * router.push('/login'), profile → profileHref="/profile". Loading —
 * single kit-token skeleton (UserProfileSkeleton is kit-internal, not
 * exported). a11y — native Radix DropdownMenu inside kit Authorized
 * (Esc/Tab, focus ring, aria-haspopup / expanded via Trigger asChild +
 * ...rest/ref-forwarded UserTrigger 0.26.0).
 * LOCALE-DECOUPLED by design: NO useI18n subscription (it would re-render
 * this header on every locale switch) and useHeaderProfile() fetches
 * /auth/me with NO `t` in effect deps (no refetch on language change).
 * userMenu labels are a mount snapshot (SSR-safe: server + first client
 * render stay `en`, stored locale applies once in the mount effect — the
 * same hydration pattern as I18nProvider). Translated hook errors stay in
 * useProfile for the /profile page (untouched, fully working).
 * NOTE: desktop kit ProfileDropdown.Action is a plain function component in
 * DropdownMenuItem asChild — Slot drops role=menuitem/roving tabindex/item
 * refs, Arrow-roving crashes Radix focusFirst on null (kit follow-up).
 */

/** Reads the stored locale (cookie-only i18n) without subscribing to it. */
function readStoredUserMenu(): Dictionary['userMenu'] {
  if (typeof document === 'undefined') return en.userMenu;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`));
  const raw = match ? decodeURIComponent(match[1]) : null;
  return isLocale(raw) && raw === 'ru' ? ru.userMenu : en.userMenu;
}

export function HeaderProfileDropdown() {
  // Mount snapshot — set once, never re-subscribed: language switches
  // neither refetch the profile nor re-render this dropdown.
  const [userMenu, setUserMenu] = useState<Dictionary['userMenu']>(() => en.userMenu);
  useEffect(() => {
    setUserMenu(readStoredUserMenu());
  }, []);
  const { profile, loading } = useHeaderProfile();
  const router = useRouter();

  const handleSignOut = useCallback(() => {
    // Единый путь sign-out: revoke + clear + снос маркера + сброс кэша,
    // затем replace /login (маркер уже снесён — возврата в /projects нет).
    void signOutAndRedirect({ router });
  }, [router]);
  const handleLogin = useCallback(() => router.push('/login'), [router]);

  if (loading) {
    return <div role="status" aria-busy="true" aria-label="Loading" className="h-8 w-8 animate-pulse rounded-md bg-muted" />;
  }

  if (!profile) {
    return <UnauthorizedUserProfile onLogin={handleLogin}>{userMenu.login}</UnauthorizedUserProfile>;
  }

  return (
    <AuthorizedUserProfile
      user={{ name: profile.name, email: profile.email }}
      onLogout={handleSignOut}
      profileHref="/profile"
      labels={{ noEmail: userMenu.noEmail, profile: userMenu.profile, logout: userMenu.signOut }}
    />
  );
}
