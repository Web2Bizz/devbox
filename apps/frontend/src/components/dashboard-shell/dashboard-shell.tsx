'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button, Header } from '@web2bizz/ui/components';
import { ThemeToggleDefault } from '@web2bizz/ui/features';
import { Sidebar, SidebarBrand } from '../layout/Sidebar';
import { Content, type ContentProps } from '../layout/Content';
import { useI18n } from '../../i18n';
import { LanguageSwitcher } from '../language-switcher';
import { HeaderProfileDropdown } from '../profile-dropdown';
import { OrganizationSwitcher } from '../organization-switcher';
import { getValidAccessToken, signOutAndRedirect } from '../../lib/auth-store';

export type DashboardHeaderBreadcrumb = {
  label: string;
  href?: string;
};

export type DashboardHeaderProps = {
  /** Optional page title rendered left of the controls. */
  title?: ReactNode;
  /** Optional breadcrumb trail (flat URLs, no locale segment). */
  breadcrumbs?: DashboardHeaderBreadcrumb[];
  /** Optional user slot (avatar / email / sign-out). */
  user?: ReactNode;
  /** Optional page-level actions rendered before theme/language controls. */
  actions?: ReactNode;
};

export type DashboardShellProps = {
  children: ReactNode;
  header?: DashboardHeaderProps;
  content?: Omit<ContentProps, 'children'>;
  /** Project-scoped sidebar items (project shell only; default = org hub). */
  sidebarItems?: { href: string; label: string }[];
  /**
   * Replaces the default nav inside the sidebar (desktop aside + mobile
   * drawer). The project shell passes the session list here on session
   * routes; `undefined` keeps the plain `SidebarNav`.
   */
  sidebar?: ReactNode;
};

type DashboardHeaderInternalProps = DashboardHeaderProps & {
  /** Opens the mobile sidebar drawer. */
  onMenu?: () => void;
};

/**
 * Visible grid-shell header built on the kit Header (@web2bizz/ui 0.25.9,
 * `components` entry, shape=rounded): SidebarBrand (logo + Rush Code + Console)
 * + OrganizationSwitcher (authenticated-only org dropdown next to the logo
 * → /organizations/[id], empty → /organizations link) + title/breadcrumbs
 * → leadingSlot, actions/user + LanguageSwitcher compact
 * + ThemeToggleDefault + HeaderProfileDropdown (ProfileDropdown from
 * `widgets` entry, useProfile mock, sign-out →/login, profile last at the
 * right edge) → trailingSlot, drawer
 * trigger → menuToggleSlot.
 * Cookie-only locale — URL never changes.
 * className="app-header" keeps the grid-area hook (globals.css) + light/dark
 * tokens. The kit bar keeps its NATIVE radius/border (shape=rounded →
 * sm:rounded-xl) — no radius:0 overrides by design (see DESIGN.md).
 * `sticky top-0`: the bar carries NO own vertical offset — the outer inset is
 * the layer's job (`p-2` on .app-shell-container), so the bar keeps its
 * position while the layer owns the gutters.
 * NOTE 0.25.9 breaking: kit Header dropped variant=sticky|fixed + wide +
 * wrapper helpers (positioning is now the consumer's job — sticky pinning
 * lives in globals.css `.app-header`); shape=rounded preserves the look.
 */
function DashboardHeader({ title, breadcrumbs, user, actions, onMenu }: DashboardHeaderInternalProps) {
  const { t } = useI18n();
  const hasLeading = Boolean(title || (breadcrumbs && breadcrumbs.length > 0));

  const menuToggle = onMenu ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onMenu}
      aria-label={t.nav.sections}
      className="inline-flex md:hidden"
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M3 5h14M3 10h14M3 15h14"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </Button>
  ) : undefined;

  const leading = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      <SidebarBrand />
      <div className="ml-4 min-w-0">
        <OrganizationSwitcher />
      </div>
      {hasLeading && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {breadcrumbs && breadcrumbs.length > 0 && (
            <nav
              aria-label={t.nav.sections}
              className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
            >
              {breadcrumbs.map((crumb, i) => {
                const isLast = i === breadcrumbs.length - 1;
                return (
                  <span key={`${crumb.label}-${i}`} className="flex items-center gap-1">
                    {i > 0 && (
                      <span aria-hidden="true" className="text-muted-foreground">
                        /
                      </span>
                    )}
                    {crumb.href && !isLast ? (
                      <Link href={crumb.href} className="text-muted-foreground hover:underline">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
                    )}
                  </span>
                );
              })}
            </nav>
          )}
          {title && (
            <div className="truncate text-lg font-semibold leading-none">{title}</div>
          )}
        </div>
      )}
    </div>
  );

  const trailing = (
    <div className="flex items-center gap-2 ml-auto shrink-0">
      {actions}
      {user}
      <LanguageSwitcher compact />
      <ThemeToggleDefault />
      <HeaderProfileDropdown />
    </div>
  );

  return (
    <Header
      shape="rounded"
      className="[grid-area:header] min-w-0 sticky top-0 z-30"
      menuToggleSlot={menuToggle}
      leadingSlot={leading}
      trailingSlot={trailing}
    />
  );
}

/**
 * Centered shell over layout blocks (see .app-shell-container / .app-shell
 * in globals.css + apps/frontend/DESIGN.md):
 * - outer: full-width container (`mx-auto w-full max-w-none px-2`
 *   = 8px side gutters, centered; kit 0.25.9 `components` entry exposes no
 *   Container export (only ChartContainer in full/widgets), so no kit import
 *   here by design)
 * - inner grid, row 1: kit Header (shape=rounded, NATIVE radius) full-width
 *   across both columns → brand + OrganizationSwitcher + breadcrumbs/title
 *   leading, actions + user + LanguageSwitcher + ThemeToggleDefault +
 *   HeaderProfileDropdown trailing (profile last, at the right edge);
 *   sticky pinning is app-owned in globals.css `.app-header`
 *   (kit 0.25.9 removed the sticky wrapper — no flatten, grid-area only)
 * - inner grid, row 2: Sidebar.tsx → plain 300px grid cell (nav only, brand
 *   lives in the Header; hidden on mobile, opened via header menu trigger
 *   as drawer + overlay; `sidebar` prop replaces the nav with custom
 *   content — the project session/chat list) + Content.tsx → <main> +
 *   .page-inner max-width wrapper, the only scrolling zone.
 *
 * Flat URLs (/projects, /secrets, …), i18n en/ru via cookie-only dictionaries,
 * force-dynamic lives in app/(dashboard)/layout.tsx.
 */
export function DashboardShell({ children, header, content, sidebarItems, sidebar }: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Chat layer: separate shell variant for /…/sessions/[sessionId] — the
  // Content panel stretches up under the Header (full vertical range) and
  // only there. Server layouts stay route-agnostic; the variant is decided
  // client-side off the path, like SessionsSidebar does.
  const pathname = usePathname() ?? '';
  const chatLayer = /\/sessions\/[^/]+\/?$/.test(pathname);
  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  /**
   * Client dead-session guard (UX complement to edge `proxy.ts` + the server
   * group-layout guard — never the sole protection). The marker cookie
   * outlives the tokens (7d TTL, cleared only on explicit sign-out paths):
   * a guest holding a stale marker passes edge/server guards and would see
   * auth pages with "session expired" states. Re-validate once on mount —
   * healthy sessions resolve synchronously with zero network (valid access
   * passes through; expiry reuses the single-flight refresh the data hooks
   * share), dead sessions clear everything and bounce to `/login`.
   */
  useEffect(() => {
    let cancelled = false;
    void getValidAccessToken().then((token) => {
      if (!token && !cancelled) void signOutAndRedirect();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="mx-auto w-full max-w-none p-2 h-dvh overflow-hidden box-border"
      data-shell="dashboard"
      data-shell-variant={chatLayer ? 'chat' : undefined}
    >
      <div className="grid grid-rows-[auto_minmax(0,1fr)] grid-cols-[300px_minmax(0,1fr)] [grid-template-areas:'header_header'_'sidebar_content'] gap-y-4 gap-x-2 h-full max-w-full box-border overflow-hidden bg-background text-foreground">
        <a href="#main-content" className="sr-only focus:not-sr-only">
          Skip to content
        </a>
        <DashboardHeader {...header} onMenu={openSidebar} />
        <Sidebar open={sidebarOpen} onClose={closeSidebar} items={sidebarItems} content={sidebar} />
        <Content
          {...content}
          variant={chatLayer ? 'chat' : content?.variant}
        >
          {children}
        </Content>
      </div>
    </div>
  );
}
