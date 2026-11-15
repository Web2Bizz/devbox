'use client';

import { Toaster } from '@web2bizz/ui/widgets';

const TOAST_POSITION = 'top-right';
const TOAST_VISIBLE_COUNT = 4;
const TOAST_DURATION_MS = 5500;
// Matches the overlay tier of `@web2bizz/ui` tokens (above dialogs, below
// blocking modals) — keep in sync with the kit if its z-scale changes.
const TOAST_Z_INDEX = 70;

/**
 * Client boundary for the kit `Toaster` (sonner).
 *
 * `app/layout.tsx` is a Server component by design (no `'use client'`,
 * see AGENTS.md Server/Client-граница): it must never import
 * `@web2bizz/ui/widgets` directly for the toaster — this thin wrapper owns
 * the client boundary, mirroring `components/theme-script`. Props are 1:1
 * with the former `src/providers.tsx` mount (`position="top-right"`,
 * `visibleToasts={4}`, `closeButton`, `duration: 5500`, `zIndex: 70` so
 * toasts sit above the Header `z-30`). Mounted once in `app/layout.tsx`
 * inside `Providers` (hence inside `ThemeProvider`) so toasts follow
 * light/dark; test-only mounts (e.g. `chat-thread.test.tsx`) are isolated
 * and must never leak a second prod `Toaster`.
 */
export function ToasterHost() {
  return (
    <Toaster
      position={TOAST_POSITION}
      visibleToasts={TOAST_VISIBLE_COUNT}
      closeButton
      toastOptions={{ duration: TOAST_DURATION_MS }}
      style={{ zIndex: TOAST_Z_INDEX }}
    />
  );
}
