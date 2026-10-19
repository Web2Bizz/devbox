import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import '@web2bizz/ui/styles.css';
import './globals.css';
import { Providers } from '@/providers';
import { en } from '@/i18n/dictionaries/en';
import { ru } from '@/i18n/dictionaries/ru';

/**
 * Localized metadata without breaking flat URLs: the `devbox-locale`
 * cookie (written by I18nProvider/LanguageSwitcher) is read per-request.
 * Default locale `en`. No `[locale]` segment, no middleware rewrite —
 * `/login`, `/projects`, … stay byte-identical in both languages.
 */
export async function generateMetadata(): Promise<Metadata> {
  let locale: string | undefined;
  try {
    const store = await cookies();
    locale = store.get('devbox-locale')?.value;
  } catch {
    locale = undefined;
  }
  const dict = locale === 'ru' ? ru : en;
  return {
    title: dict.metadata.title,
    description: dict.metadata.description,
    icons: {
      icon: [
        { url: '/icon.png', type: 'image/png' },
        { url: '/devbox-logo.png', type: 'image/png' },
      ],
      shortcut: '/devbox-logo.png',
      apple: '/devbox-logo.png',
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: ThemeProvider toggles `light`/`dark` class on
    // <html> after mount; the server prerender can't know the stored theme.
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
