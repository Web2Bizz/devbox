'use client';

import { useEffect, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@web2bizz/ui/features';
import { I18nProvider } from './i18n';
import { createQueryClient, registerActiveQueryClient } from './lib/query-client';

/**
 * Client-side providers for the Next.js App Router.
 *
 * Mount-guarded: `@web2bizz/ui` ThemeProvider reads `localStorage` in its
 * `useState` initializer (no SSR guard), so rendering it during server
 * prerender would throw `ReferenceError: localStorage is not defined`.
 * Children render on the server without theme context (useTheme falls back
 * to its default `system` value outside a provider), then the real provider
 * mounts on the client after hydration.
 *
 * I18nProvider is SSR-safe (default `en`, hydration in effect) so it wraps
 * everything: children always have `useI18n`, theme arrives after mount.
 * Cookie-only locale keeps flat URLs (/login, /projects, …) untouched.
 *
 * Unique storageKey per app (anti-pattern: shared keys collide when several
 * apps share one origin during local dev).
 */
const ReactQueryDevtools = dynamic(
  () => import('@tanstack/react-query-devtools').then((m) => m.ReactQueryDevtools),
  { ssr: false },
);

export function Providers({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [queryClient] = useState(() => createQueryClient());

  useEffect(() => {
    setMounted(true);
  }, []);

  // Expose the mounted client to the module-level sign-out path so
  // signOutAndRedirect() can clear cached user data on logout/expiry.
  useEffect(() => {
    registerActiveQueryClient(queryClient);
    return () => registerActiveQueryClient(null);
  }, [queryClient]);

  if (!mounted) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider>{children}</I18nProvider>
        {process.env.NODE_ENV === 'development' && (
          <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
        )}
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider defaultTheme="system" storageKey="devbox-frontend-theme">
          {children}
        </ThemeProvider>
      </I18nProvider>
      {process.env.NODE_ENV === 'development' && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
      )}
    </QueryClientProvider>
  );
}
