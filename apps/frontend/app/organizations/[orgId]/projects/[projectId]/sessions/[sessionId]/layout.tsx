import type { ReactNode } from 'react';

/**
 * Session chat segment layout (Server, CODE_OF_CONDUCT §2).
 * Единственный владелец геометрии треда: `grid`, высота скроллера
 * (`h-[calc(100dvh_-_9rem)]` — скроллер фичи тянется `h-full`),
 * отступ под Header. Без 'use client', без хуков.
 * Фича `chat-thread` получает геометрию отсюда и сама
 * `h-[100dvh]`/`absolute`-пин не задаёт.
 */
export default function SessionChatLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid h-[calc(100dvh_-_9rem)] min-h-[20rem] gap-2 pt-[calc(var(--header-height)_+_1rem)]"
      data-chat-thread-layout="session"
    >
      {children}
    </div>
  );
}
