'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useState, type KeyboardEvent } from 'react';
import { Button } from '@web2bizz/ui/components';
import { useI18n } from '../../i18n';

export type SidebarNavItem = {
  href: string;
  label: string;
};

/**
 * Brand row: logo PNG + DevBox wordmark + console subtitle.
 * Rendered in the Header leadingSlot (desktop + mobile) and as a fallback
 * at the top of the mobile drawer. Brand tokens live in globals.css
 * (`.text-gradient-brand` / `.logo-glow`).
 */
export function SidebarBrand() {
  const { t } = useI18n();

  return (
    <div className="brand-row">
      <Image
        src="/devbox-logo.png"
        alt="DevBox"
        width={36}
        height={36}
        className="logo-glow"
        priority
      />
      <div>
        <p className="text-gradient-brand text-lg font-semibold leading-none">
          DevBox
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

  const handleGroupKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    id: string,
  ) => {
    // Enter/Space toggle natively via <button> onClick.
    // Escape: collapse the group.
    if (event.key === 'Escape') {
      event.stopPropagation();
      setExpanded((prev) => ({ ...prev, [id]: false }));
    }
  };

  return (
    <nav aria-label={t.nav.sections} className="app-sidebar-nav">
      {NAV.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            data-active={active ? 'true' : undefined}
            onClick={onNavigate}
            className="app-sidebar-link w-full justify-start"
          >
            {item.label}
          </Link>
        );
      })}
      {EXPANDABLE.map((item) => {
        const isOpen = expanded[item.id] ?? false;
        const sublistId = `sidebar-sublist-${item.id}`;
        return (
          <div key={item.id} className="app-sidebar-group">
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={sublistId}
              onClick={() => {
                setExpanded((prev) => ({ ...prev, [item.id]: !isOpen }));
              }}
              onKeyDown={(event) => handleGroupKeyDown(event, item.id)}
              className="app-sidebar-link w-full justify-start"
            >
              <span className="app-sidebar-label">{item.label}</span>
              <span aria-hidden="true" className="app-sidebar-chevron">
                ▾
              </span>
            </button>
            <ul
              id={sublistId}
              hidden={!isOpen}
              className="app-sidebar-sublist"
            >
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
                          className="app-sidebar-link w-full justify-start"
                        >
                          {sub.label}
                        </Link>
                      </li>
                    );
                  })
                : // TODO: sub-items for databases — pages land separately.
                  null}
            </ul>
          </div>
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
            className="app-sidebar-link w-full justify-start"
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
      <aside aria-label={t.nav.sections} className="app-sidebar hidden md:flex">
        <SidebarNav />
      </aside>

      {open && (
        <div className="md:hidden">
          <div
            className="app-sidebar-overlay"
            aria-hidden="true"
            onClick={onClose}
          />
          <aside aria-label={t.nav.sections} className="app-sidebar-drawer">
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
