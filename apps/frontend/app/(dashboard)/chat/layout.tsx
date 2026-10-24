import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { en } from '@/i18n/dictionaries/en';
import { ru } from '@/i18n/dictionaries/ru';

/**
 * Segment metadata for /chat: localized via the `rush-code-locale` cookie
 * (same cookie-only approach as the root layout — flat URL stays `/chat`
 * in both languages, default `en`).
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
    title: `${dict.chat.title} — ${dict.metadata.title}`,
    description: dict.chat.subtitle,
  };
}

export default function ChatSegmentLayout({ children }: { children: ReactNode }) {
  return children;
}
