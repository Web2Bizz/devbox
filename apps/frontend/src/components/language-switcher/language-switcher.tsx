'use client';

import {
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@web2bizz/ui/components';
import { isLocale, useI18n } from '../../i18n';

/**
 * Language switcher: locale dropdown next to ThemeToggleDefault.
 * Kit-native trigger + Radix menu (@web2bizz/ui 0.26.0 `components` entry —
 * DropdownMenu/Trigger/Content/RadioGroup/RadioItem re-export Radix
 * primitives, so Esc/selection close, Tab reachability, focus ring and
 * aria-haspopup/expanded come from Radix, animations stay kit-native —
 * no custom transform/shadow per DESIGN.md §3.1, radii stay kit tokens
 * per §3). Trigger child is a NATIVE <button> (kit Button is a plain
 * function component without ref-forwarding — passing it into
 * Trigger asChild would drop Slot props/refs, the known kit bug
 * documented in profile-dropdown.test.tsx — so styling comes from kit
 * `buttonVariants`, not the Button component). Items are native
 * DropdownMenuRadioItem (role=menuitemradio + aria-checked natively,
 * kit ItemIndicator dot marks the active locale — no plain function
 * in asChild anywhere).
 * Height parity with ThemeToggleDefault: kit Button size="icon" is
 * `size-9` (h-9/36px) — the trigger uses size="default" (h-9/36px),
 * NOT size="sm" (h-8/32px), so both header controls share one height
 * via kit utilities only.
 * Cookie-only locale (see src/i18n) — switching never changes the URL.
 */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();

  const currentLabel =
    compact ? locale.toUpperCase() : locale === 'en' ? t.language.en : t.language.ru;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`${buttonVariants({ variant: 'ghost', size: 'default' })} border-0 shadow-none outline-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none`}
          aria-label={t.language.label}
          title={t.language.label}
        >
          {currentLabel}
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
      <DropdownMenuContent align="end" aria-label={t.language.label}>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            if (isLocale(value)) setLocale(value);
          }}
        >
          <DropdownMenuRadioItem value="en" aria-label={t.language.switchToEn}>
            {t.language.en}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="ru" aria-label={t.language.switchToRu}>
            {t.language.ru}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
