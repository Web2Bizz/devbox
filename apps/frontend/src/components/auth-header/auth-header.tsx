'use client';

import { Header } from '@web2bizz/ui/components';
import { ThemeToggleDefault } from '@web2bizz/ui/features';
import { SidebarBrand } from '../layout/Sidebar';
import { LanguageSwitcher } from '../language-switcher';

/**
 * Guest header for the (auth) group: same kit Header bar as the dashboard
 * (shape=rounded, className="app-header" for the grid-area; sticky `top-0`
 * — the bar carries no own offset, the outer inset is the layer's job;
 * NATIVE radius/border — no overrides by design, see DESIGN.md).
 * Leading reuses SidebarBrand (logo + Rush Code + Console, single source).
 * Trailing is guest-only: LanguageSwitcher compact + ThemeToggleDefault —
 * no profile/user/menuToggle slots (no sidebar, no session on /login).
 * Cookie-only locale — switching never changes the URL.
 */
export function AuthHeader() {
  return (
    <Header
      shape="rounded"
      className="[grid-area:header] min-w-0 sticky top-0 z-30"
      leadingSlot={<SidebarBrand />}
      trailingSlot={
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <LanguageSwitcher compact />
          <ThemeToggleDefault />
        </div>
      }
    />
  );
}
