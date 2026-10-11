'use client';

/**
 * ADR (i18n, Next 15.5 App Router, flat URLs):
 *
 * Decision: cookie-only locale + hand-rolled dictionaries, NO `[locale]`
 * URL segment, NO middleware rewrite.
 *
 * Why not `next-intl` / `[locale]` segment:
 * - Task requires flat routes (/login, /projects, /secrets, /profile,
 *   /ai-providers) + existing redirects (`/` → `/login` in next.config +
 *   app/page.tsx). A `[locale]` segment would rewrite every URL
 *   (/:locale/login, …), break `redirect('/login')`, `router.push`,
 *   `usePathname() === href` active-state in DashboardShell, and all
 *   deep links. Cookie-only keeps URLs byte-identical in EN and RU.
 * - No new dependency (task lists 5 deps already; dictionaries are ~2 files).
 * - `generateMetadata` stays per-request: it reads the `devbox-locale`
 *   cookie server-side, so title/description localize without URL change.
 *
 * Compatibility with ThemeProvider mount-guard (src/providers.tsx):
 * - ThemeProvider reads `localStorage` in its `useState` initializer (no SSR
 *   guard) → must mount client-only. I18nProvider below is SSR-safe (no
 *   storage access during render; hydration happens in `useEffect`), so it
 *   renders on the server AND wraps the mount-guarded ThemeProvider: children
 *   always have `useI18n`, theme context arrives after hydration.
 * - `document.documentElement.lang` syncs in `useEffect` (no SSR DOM access).
 *
 * Persistence: `devbox-locale` cookie (1y, SameSite=Lax, path=/) — readable
 * by `generateMetadata` — mirrored to `localStorage` for instant client boot.
 * Default locale: `en`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en } from './dictionaries/en';
import { ru } from './dictionaries/ru';
import type { Dictionary } from './dictionaries/types';

export const LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'devbox-locale';
export const LOCALE_STORAGE_KEY = 'devbox-locale';

const dictionaries: Record<Locale, Dictionary> = { en, ru };

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'ru';
}

function readStoredLocale(): Locale {
  if (typeof document !== 'undefined') {
    const match = document.cookie.match(/(?:^|;\s*)devbox-locale=([^;]*)/);
    if (match && isLocale(decodeURIComponent(match[1]))) {
      return decodeURIComponent(match[1]) as Locale;
    }
  }
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (isLocale(raw)) return raw;
    } catch {
      // private mode / blocked storage — fall through to default
    }
  }
  return DEFAULT_LOCALE;
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: Dictionary;
}

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: en,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  // SSR-safe: start with default, hydrate stored locale in effect
  // (no localStorage/document access during prerender).
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocaleState(readStoredLocale());
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      if (typeof document !== 'undefined') {
        document.cookie =
          `${LOCALE_COOKIE}=${encodeURIComponent(next)}; path=/; max-age=31536000; SameSite=Lax`;
        document.documentElement.lang = next;
      }
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      }
    } catch {
      // persistence is best-effort; in-memory locale still applies
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: dictionaries[locale] ?? en }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}

export type { Dictionary };
