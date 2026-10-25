'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@web2bizz/ui/components';
import { useI18n } from '../../../i18n';

export type SidebarNavItem = {
  href: string;
  label: string;
};

/**
 * Brand row: logo PNG + Rush Code wordmark + console subtitle.
 * Rendered in the Header leadingSlot (desktop + mobile) and as a fallback
 * at the top of the mobile drawer. Brand tokens live in globals.css
 * (`.text-gradient-brand` / `.logo-glow`).
 */
export function SidebarBrand() {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-3.5">
      <Image
        src="/logo.png"
        alt="Rush Code"
        width={36}
        height={36}
        className="logo-glow"
        priority
      />
      <div>
        <p className="text-gradient-brand text-lg font-semibold leading-none">
          Rush Code
        </p>
        <p className="text-muted-foreground text-sm">{t.nav.console}</p>
      </div>
    </div>
  );
}

/**
 * Flat-URL nav across the dashboard sections, rendered as a vertical
 * full-width list of direct Next Links. Active state via usePathname()
 * (no locale segment by design, see src/i18n ADR) + i18n labels
 * (en/ru dictionaries). Registries/Databases/Data persist are expandable
 * button groups (button trigger with aria-expanded/aria-controls + chevron,
 * Enter/Space toggle natively, Esc collapses, no navigation on toggle):
 * Registries holds /registry/docker (live catalog proxy,
 * [id] deferred) + /registry/npm links (old /registries + /npm deep links
 * redirect, see next.config.mjs) — hubs (/registry and future
 * storages/databases hubs) stay outside the Sidebar, reachable by direct URL;
 * Databases keeps an empty sub-list with TODO — sub-pages land separately;
 * Data persist holds S3 + Volumes links. Brokers is a flat Link.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const NAV: readonly SidebarNavItem[] = [
    { href: '/projects', label: t.nav.projects },
    { href: '/organizations', label: t.nav.organizations },
    { href: '/secrets', label: t.nav.secrets },
    { href: '/ai-providers', label: t.nav.aiProviders },
  ] as const;

  const EXPANDABLE: readonly {
    id: string;
    label: string;
    items?: readonly SidebarNavItem[];
  }[] = [
    {
      id: 'registries',
      label: t.nav.registries,
      items: [
        { href: '/registry/docker', label: t.registries.dockerImages },
        { href: '/registry/npm', label: t.npm.packages },
      ],
    },
    { id: 'databases', label: t.nav.databases },
    {
      id: 'data-persist',
      label: t.nav.dataPersist,
      items: [
        { href: '/s3', label: t.nav.s3 },
        { href: '/volumes', label: t.nav.volumes },
      ],
    },
  ] as const;

  const FLAT_EXTRA: readonly SidebarNavItem[] = [
    { href: '/brokers', label: t.nav.brokers },
  ] as const;

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
      <nav aria-label={t.nav.sections} className="flex flex-col gap-1 w-full">
      {NAV.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            data-active={active ? 'true' : undefined}
            onClick={onNavigate}
            className="flex items-center w-full justify-start gap-2 px-3 py-2 rounded-[var(--radius-md)] text-sm font-medium leading-5 text-muted-foreground no-underline border border-transparent transition-colors duration-150 hover:text-foreground hover:bg-[var(--sidebar-accent,var(--muted))] aria-[current=page]:text-foreground aria-[current=page]:bg-[var(--sidebar-accent,var(--muted))] aria-[current=page]:border-[var(--sidebar-border,var(--border))] focus-visible:outline-2 focus-visible:outline-[var(--sidebar-ring,var(--ring))] focus-visible:outline-offset-2"
          >
            {item.label}
          </Link>
        );
      })}
      {EXPANDABLE.map((item) => {
        const isOpen = expanded[item.id] ?? false;
        return (
          <Collapsible
            key={item.id}
            open={isOpen}
            onOpenChange={(open) => {
              setExpanded((prev) => ({ ...prev, [item.id]: open }));
            }}
            className="flex flex-col w-full"
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center w-full justify-start gap-2 px-3 py-2 rounded-[var(--radius-md)] text-sm font-medium leading-5 text-left text-muted-foreground no-underline border border-transparent transition-colors duration-150 hover:text-foreground hover:bg-[var(--sidebar-accent,var(--muted))] data-[state=open]:text-foreground data-[state=open]:bg-[var(--sidebar-accent,var(--muted))] data-[state=open]:border-[var(--sidebar-border,var(--border))] focus-visible:outline-2 focus-visible:outline-[var(--sidebar-ring,var(--ring))] focus-visible:outline-offset-2"
              >
                <span className="flex-1 min-w-0 text-left">{item.label}</span>
                <span aria-hidden="true" className={`shrink-0 text-muted-foreground transition-transform duration-150 ${isOpen ? 'rotate-0' : '-rotate-90'}`}>
                  ▾
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-1 w-full m-0 p-0 list-none">
              <ul className="flex flex-col gap-1 w-full m-0 p-0 pl-4 list-none">
                {item.items
                  ? item.items.map((sub) => {
                      const subActive = isActive(sub.href);
                      return (
                        <li key={sub.href}>
                          <Link
                            href={sub.href}
                            aria-current={subActive ? 'page' : undefined}
                            data-active={subActive ? 'true' : undefined}
                            onClick={onNavigate}
                            className="flex items-center w-full justify-start gap-2 px-3 py-2 rounded-[var(--radius-md)] text-sm font-medium leading-5 text-muted-foreground no-underline border border-transparent transition-colors duration-150 hover:text-foreground hover:bg-[var(--sidebar-accent,var(--muted))] aria-[current=page]:text-foreground aria-[current=page]:bg-[var(--sidebar-accent,var(--muted))] aria-[current=page]:border-[var(--sidebar-border,var(--border))] focus-visible:outline-2 focus-visible:outline-[var(--sidebar-ring,var(--ring))] focus-visible:outline-offset-2"
                          >
                            {sub.label}
                          </Link>
                        </li>
                      );
                    })
                  : // TODO: sub-items for databases — pages land separately.
                    null}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
      {FLAT_EXTRA.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            data-active={active ? 'true' : undefined}
            onClick={onNavigate}
            className="flex items-center w-full justify-start gap-2 px-3 py-2 rounded-[var(--radius-md)] text-sm font-medium leading-5 text-muted-foreground no-underline border border-transparent transition-colors duration-150 hover:text-foreground hover:bg-[var(--sidebar-accent,var(--muted))] aria-[current=page]:text-foreground aria-[current=page]:bg-[var(--sidebar-accent,var(--muted))] aria-[current=page]:border-[var(--sidebar-border,var(--border))] focus-visible:outline-2 focus-visible:outline-[var(--sidebar-ring,var(--ring))] focus-visible:outline-offset-2"
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export type SidebarProps = {
  /** Mobile drawer open state (desktop aside is always visible via CSS). */
  open?: boolean;
  onClose?: () => void;
};

/**
 * Visible vertical sidebar:
 * - desktop (md+): plain <aside> grid cell — nav only (the brand row lives
 *   in the Header leadingSlot via SidebarBrand, see dashboard-shell.tsx);
 * - mobile: hidden, opened via header menu trigger as fixed drawer + overlay
 *   (drawer keeps its own SidebarBrand fallback + close button).
 */
export function Sidebar({ open = false, onClose }: SidebarProps) {
  const { t } = useI18n();

  return (
    <>
      <aside aria-label={t.nav.sections} className="hidden md:flex grid-area-[sidebar] w-[300px] h-full min-h-0 flex-col gap-6 p-6 px-4 border border-border rounded-[var(--radius-lg)] bg-[var(--sidebar,var(--card))] overflow-y-auto">
        <SidebarNav />
      </aside>

      {open && (
        <div className="md:hidden">
          <div
            className="fixed inset-0 z-40 bg-[var(--overlay-scrim)]"
            aria-hidden="true"
            onClick={onClose}
          />
          <aside aria-label={t.nav.sections} className="fixed top-0 left-0 bottom-0 w-68 z-50 flex flex-col gap-6 p-6 px-4 bg-background border-r border-border overflow-y-auto">
            <div className="flex items-start justify-between gap-2">
              <SidebarBrand />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label={t.common.cancel}
              >
                ✕
              </Button>
            </div>
            <SidebarNav onNavigate={onClose} />
          </aside>
        </div>
      )}
    </>
  );
}
