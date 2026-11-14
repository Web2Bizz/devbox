'use client';

import { ThemeScript as KitThemeScript } from '@web2bizz/ui/features';
import type { ThemeScriptProps } from './types';

/**
 * Client boundary for the kit `ThemeScript`.
 *
 * `app/layout.tsx` is a Server component by design (no `'use client'`,
 * see AGENTS.md Server/Client-граница): it must never import
 * `@web2bizz/ui/features` directly — the kit `features.js` bundle calls
 * `createContext` at module scope without its own `'use client'` directive,
 * so a Server import crashes with `Runtime TypeError createContext`.
 * This thin wrapper owns the client boundary: the Server layout renders
 * `<ThemeScript>` (this file), Next splits the kit bundle into the client
 * graph, the Server graph stays context-free.
 *
 * Props are 1:1 with the kit (`storageKey="theme"`,
 * `defaultTheme="system"`): the inline script paints the `dark` class
 * pre-hydration (no flash), `suppressHydrationWarning` on `<html>`
 * absorbs the class-attr mismatch instead of a mount-guard (banned).
 */
export function ThemeScript({ storageKey = 'theme', defaultTheme = 'system' }: ThemeScriptProps) {
  return <KitThemeScript storageKey={storageKey} defaultTheme={defaultTheme} />;
}
