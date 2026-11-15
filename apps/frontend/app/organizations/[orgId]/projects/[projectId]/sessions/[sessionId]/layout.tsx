import type { ReactNode } from 'react';

/**
 * Session chat segment layout (Server, no interactivity).
 * Owns placement only: bounded thread box + composer overlay pin.
 * Chat variant slides the panel UNDER the header (content spans both grid
 * rows), so the header costs zero vertical space here: height = viewport
 * minus shell container pad (2×0.5rem) and page-inner pad (2×0.5rem).
 * Thread scrolls inside the box; composer floats above its bottom (z-20).
 */
export const SESSION_THREAD_CLASSNAME = 'h-full min-h-0 min-w-0';
export const SESSION_COMPOSER_CLASSNAME =
  'absolute right-0 bottom-2 left-0 z-20 mx-auto w-[60%]';

export default function SessionChatLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid h-[calc(100dvh_-_2rem)] min-h-[20rem] min-w-0 gap-2">
      <div className="h-full min-h-0 min-w-0">{children}</div>
    </div>
  );
}
