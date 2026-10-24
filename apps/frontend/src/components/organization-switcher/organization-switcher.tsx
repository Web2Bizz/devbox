'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo } from 'react';
import {
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web2bizz/ui/components';
import { useHeaderProfile } from '../../hooks/useProfile';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useI18n } from '../../i18n';

/**
 * Header organization switcher — kit DropdownMenu (`components` entry).
 * Thin data adapter (<40 lines of UI): useHeaderProfile() gates rendering
 * (authenticated only — null for guests, proxy already guards the
 * route), useOrganizations() supplies list/loading/error (fail-closed via
 * getValidAccessToken, no fallbacks). Active org is derived from the
 * pathname (`/organizations/[id]`), switching is router.push to the detail
 * page. Empty list renders a plain Link to /organizations.
 * Trigger is a NATIVE <button> styled via kit `buttonVariants` (kit Button
 * is a plain function component without ref-forwarding — passing it into
 * Trigger asChild would drop Slot props/refs, the known kit bug documented
 * in profile-dropdown.test.tsx / language-switcher). Items are native
 * DropdownMenuRadioItem (role=menuitemradio + aria-checked natively, kit
 * ItemIndicator marks the active org — no plain function in asChild
 * anywhere) + one native DropdownMenuItem for the hub link (onSelect push,
 * no asChild Link — avoids the same Slot/ref drop). Height parity with
 * ThemeToggleDefault: size="default" (h-9/36px), same as LanguageSwitcher.
 * Cookie-only locale — switching orgs changes the URL, never the locale.
 */
export function OrganizationSwitcher() {
  const { profile, loading: profileLoading } = useHeaderProfile();
  const { organizations, loading: orgsLoading, error } = useOrganizations();
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();

  const activeId = useMemo(() => {
    if (!pathname) return null;
    const match = pathname.match(/^\/organizations\/([^/]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }, [pathname]);

  const activeOrg = useMemo(
    () => organizations.find((o) => o.id === activeId) ?? null,
    [organizations, activeId],
  );

  // Skeleton while identity resolves (same kit-token placeholder shape as
  // HeaderProfileDropdown) — avoids guest/auth flash before the gate below.
  if (profileLoading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading"
        className="h-8 w-24 animate-pulse rounded-md bg-muted"
      />
    );
  }

  // Authenticated only — reuse the useHeaderProfile authorized branch:
  // guests render nothing (fail-closed; proxy already guards).
  if (!profile) return null;

  if (orgsLoading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t.common.loading}
        className="h-9 w-32 animate-pulse rounded-md bg-muted"
      />
    );
  }

  if (error) {
    return (
      <button
        type="button"
        disabled
        title={error}
        aria-label={t.nav.organizations}
        className={`${buttonVariants({ variant: 'ghost', size: 'default' })} border-0 shadow-none outline-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none`}
      >
        <span className="min-w-0 max-w-44 truncate">{t.nav.organizations}</span>
      </button>
    );
  }

  // Empty — plain link to the hub (no dropdown with zero options).
  if (organizations.length === 0) {
    return (
      <Link
        href="/organizations"
        aria-label={t.nav.organizations}
        className={`${buttonVariants({ variant: 'ghost', size: 'default' })} border-0 shadow-none outline-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none`}
      >
        <span className="min-w-0 max-w-44 truncate">{t.nav.organizations}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="m6 9 6 6 6-6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Link>
    );
  }

  const triggerLabel = activeOrg ? activeOrg.name : t.nav.organizations;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`${buttonVariants({ variant: 'ghost', size: 'default' })} border-0 shadow-none outline-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none`}
          aria-label={t.nav.organizations}
          title={triggerLabel}
        >
          <span className="min-w-0 max-w-44 truncate">{triggerLabel}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m6 9 6 6 6-6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={t.nav.organizations}>
        <DropdownMenuLabel>{t.nav.organizations}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={activeId ?? ''}
          onValueChange={(value) => {
            if (!value) return;
            router.push(`/organizations/${value}`);
          }}
        >
          {organizations.map((org) => (
            <DropdownMenuRadioItem key={org.id} value={org.id} aria-label={org.name}>
              {org.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          aria-label={t.orgs.back}
          onSelect={() => {
            router.push('/organizations');
          }}
        >
          {t.orgs.back}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
