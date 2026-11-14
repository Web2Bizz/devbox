import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import '@web2bizz/ui/styles.css';
import './globals.css';
import { Providers } from '@/providers';
import { ToasterHost } from '@/components/toaster-host';
import { ThemeScript } from '@/components/theme-script';
import { en } from '@/i18n/dictionaries/en';
import { ru } from '@/i18n/dictionaries/ru';

/**
 * Localized metadata without breaking flat URLs: the `rush-code-locale`
 * cookie (written by I18nProvider/LanguageSwitcher) is read per-request.
 * Default locale `en`. No `[locale]` segment, no middleware rewrite —
 * `/login`, `/projects`, … stay byte-identical in both languages.
 */
export async function generateMetadata(): Promise<Metadata> {
  let locale: string | undefined;
  try {
    const store = await cookies();
    locale = store.get('rush-code-locale')?.value;
  } catch {
    locale = undefined;
  }
  const dict = locale === 'ru' ? ru : en;
  return {
    title: dict.metadata.title,
    description: dict.metadata.description,
    icons: {
      icon: [
        { url: '/assets/favicon.ico', type: 'image/x-icon' },
        { url: '/assets/icon.png', type: 'image/png', sizes: '512x512' },
      ],
      shortcut: '/assets/favicon.ico',
      apple: [{ url: '/assets/apple-icon.png', sizes: '180x180' }],
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript storageKey="theme" defaultTheme="system" />
      </head>
      <body>
        <Providers>
          {children}
          <ToasterHost />
        </Providers>
      </body>
    </html>
  );
}
