/**
 * LanguageSwitcher — locale dropdown (kit `components` entry DropdownMenu
 * primitives + native <button> trigger styled via kit `buttonVariants`).
 *
 * Covers: closed trigger exposes menu semantics (aria-haspopup/expanded +
 * aria-label), click opens a menu with 2 native menuitemradio options
 * (active marked aria-checked, kit ItemIndicator — no plain function in
 * asChild, cf. the kit bug NOTE in profile-dropdown.test.tsx), selecting
 * RU switches locale via setLocale (cookie-only, URL untouched, menu
 * closes), Escape closes + returns focus, ru labels via I18nProvider +
 * cookie.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

// Happy-DOM gaps Radix DropdownMenu relies on (guarded: newer happy-dom
// already ships some of these).
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
if (typeof window.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: ResizeObserverStub,
  });
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof window.requestAnimationFrame !== 'function') {
  Object.defineProperty(window, 'requestAnimationFrame', {
    writable: true,
    value: (cb: FrameRequestCallback): number =>
      Number(setTimeout(() => cb(Date.now()), 0)),
  });
}
for (const key of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const) {
  if (typeof HTMLElement.prototype[key] !== 'function') {
    (HTMLElement.prototype as unknown as Record<string, unknown>)[key] =
      key === 'hasPointerCapture' ? () => false : () => {};
  }
}

const { cleanup, render, screen, waitFor } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { I18nProvider } = await import('../../i18n');
const { LanguageSwitcher } = await import('../language-switcher');

afterEach(() => {
  cleanup();
  document.cookie = 'devbox-locale=; path=/; max-age=0';
  try {
    window.localStorage.removeItem('devbox-locale');
  } catch {
    // storage may be unavailable — ignore
  }
  document.documentElement.lang = 'en';
});

const TRIGGER_NAME = 'Language';
const FIND_TIMEOUT = 5000;

function renderSwitcher() {
  render(
    <I18nProvider>
      <LanguageSwitcher compact />
    </I18nProvider>,
  );
}

describe('LanguageSwitcher (locale dropdown)', () => {
  test('closed trigger exposes menu semantics with the current locale', async () => {
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('data-state')).toBe('closed');
    expect(trigger.textContent).toContain('EN');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('click opens a menu with EN/RU options, active marked aria-checked', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);

    await screen.findByRole('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const options = screen.getAllByRole('menuitemradio');
    expect(options).toHaveLength(2);
    const en = screen.getByRole('menuitemradio', { name: 'Switch to English' });
    const ru = screen.getByRole('menuitemradio', { name: 'Switch to Russian' });
    // Native RadioItem semantics: active locale is checked.
    expect(en.getAttribute('aria-checked')).toBe('true');
    expect(ru.getAttribute('aria-checked')).toBe('false');
  });

  test('selecting RU switches locale (cookie-only, URL untouched) and closes the menu', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    const urlBefore = window.location.href;
    await user.click(screen.getByRole('menuitemradio', { name: 'Switch to Russian' }));

    // Selection closes the menu (Radix default) …
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // … the trigger shows the new locale …
    await waitFor(() => expect(trigger.textContent).toContain('RU'));
    // … persistence is cookie-only: URL never changes, cookie + <html lang> do.
    expect(window.location.href).toBe(urlBefore);
    expect(document.cookie).toContain('devbox-locale=ru');
    expect(document.documentElement.lang).toBe('ru');
  });

  test('Escape closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  test('ru locale renders translated labels', async () => {
    document.cookie = 'devbox-locale=ru; path=/';
    const user = userEvent.setup();
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Язык' }, { timeout: FIND_TIMEOUT });
    await waitFor(() => expect(trigger.textContent).toContain('RU'));

    await user.click(trigger);
    await screen.findByRole('menu');
    expect(
      screen.getByRole('menuitemradio', { name: 'Переключить на английский' }),
    ).toBeDefined();
    expect(
      screen.getByRole('menuitemradio', { name: 'Переключить на русский' }),
    ).toBeDefined();
    expect(
      screen
        .getByRole('menuitemradio', { name: 'Переключить на русский' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
});
