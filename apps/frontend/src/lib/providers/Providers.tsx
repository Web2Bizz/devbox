'use client';

import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@web2bizz/ui/features';
import { getQueryClient } from '@/lib/query-client';

/**
 * Client-side providers for the Next.js App Router.
 *
 * Pure JSX composition with no branching, no state, no effects:
 * `ThemeProvider > I18nProvider > QueryClientProvider > children`.
 *
 * Theme is the kit SSR-safe `ThemeProvider`/`ThemeScript`
 * (`@web2bizz/ui/features`, 1:1 props `defaultTheme="system"`
 * `storageKey="theme"`): `ThemeScript` in `app/layout.tsx` `<head>` paints
 * the `dark` class pre-hydration (no flash), the provider stays the outermost
 * layer so `ThemeToggleDefault` (dashboard-shell/auth-header) shares
 * its native context. `storageKey="theme"` preserves stored preferences
 * (parity with speka-click). `suppressHydrationWarning` on `<html>`
 * (app/layout.tsx) absorbs the class-attr mismatch instead of a mount-guard
 * (banned).
 * The kit sonner `Toaster` is NOT mounted here: it lives in the client
 * `ToasterHost` (`components/toaster-host`), rendered by `app/layout.tsx`
 * inside `Providers` (hence inside the theme) so toasts follow light/dark.
 * No mount-guard / AppShell gate anywhere (banned): `suppressHydrationWarning`
 * on `<html>` (app/layout.tsx) absorbs the class-attr mismatch instead.
 *
 * I18nProvider is SSR-safe (default `en`, hydration in effect) so it wraps
 * everything below the theme: children always have `useI18n`.
 *
 * QueryClient is a module singleton (`getQueryClient` in lib/query-client):
 * one client per browser tab (StrictMode/HMR-safe, no per-mount leak);
 * SSR gets a fresh client per call. The singleton self-registers as the
 * active client for the module-level sign-out path (`signOutAndRedirect`
 * in lib/auth-store clears it via `getActiveQueryClient()?.clear()`;
 * tests/HMR reset via `registerActiveQueryClient(null)`).
 */

const ReactQueryDevtools = dynamic(
  () => import('@tanstack/react-query-devtools').then((m) => m.ReactQueryDevtools),
  { loading: () => null, ssr: false },
);

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();

  return (
    <ThemeProvider defaultTheme="system" storageKey="theme">
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          {children}
          {process.env.NODE_ENV === 'development' && (
            <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
          )}
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
