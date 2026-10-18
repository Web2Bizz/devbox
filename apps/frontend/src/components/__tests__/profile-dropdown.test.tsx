/**
 * HeaderProfileDropdown — pure kit (@web2bizz/ui 0.26.0 `widgets` entry:
 * AuthorizedUserProfile + UnauthorizedUserProfile + thin data adapter).
 *
 * Covers: kit UserTrigger rest/ref forward (0.25.9 regression stays green on
 * 0.26.0), open/close (click opens, Escape closes + focus return), sign-out
 * pushes /login, Tab reachability, ru labels via I18nProvider + cookie.
 * Trigger accessible name is now the kit displayName ("Rush Code Developer"),
 * not the removed userMenu.openMenu aria-label (kit trigger renders the
 * name visibly; Radix still supplies aria-haspopup/expanded + data-state).
 *
 * NOTE (kit follow-up, NOT this task): 0.26.0 desktop ProfileDropdown.Action
 * wraps a plain function component in DropdownMenuItem asChild, so Slot
 * props (role=menuitem, roving tabindex, item refs) are dropped — Arrow
 * roving crashes Radix focusFirst on null refs (ArrowDown on an open menu
 * throws `candidate.focus` TypeError and unmounts). Keyboard cover stays on
 * the working path (Tab into menu + Escape); full roving needs a kit patch
 * (forwardRef/Slot on ProfileDropdownAction).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
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

// HeaderProfileDropdown calls useRouter() from next/navigation (throws
// without an app-router mount) — stub the push it uses on sign-out/login.
// usePathname is stubbed too: the mock registry is process-global across
// test files, and Sidebar (usePathname) must link against it in full runs.
const pushMock = mock((_href: string) => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/',
}));

// Canned identity (module top — mock factories below close over these).
const ME_USER = {
  id: 'mock-user-1',
  firstName: 'Rush Code',
  lastName: 'Developer',
  email: 'dev@rush-code.local',
  provider: 'local' as const,
  createdAt: '2026-01-15T09:00:00.000Z',
};
const ME_USER_WITH_LIMITS = {
  ...ME_USER,
  limits: {
    daily: { used: 5, total: 100 },
    weekly: { used: 20, total: 500 },
    monthly: { used: 100, total: 2000 },
  },
};
function currentMeUser() {
  const override = (globalThis as Record<string, unknown>).__TEST_ME_USER__;
  return (override as typeof ME_USER_WITH_LIMITS | undefined) ?? ME_USER;
}
const cannedSession = {
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  tokenType: 'bearer',
  expiresIn: 900,
  user: ME_USER,
} as const;

// useProfile is real-API now (GET /auth/me) — other test files register a
// process-global mock.module('../../api/client') with only their own
// methods, which would leave api.me undefined here. Re-register the same
// specifier with the auth surface (last registration wins at our load).
mock.module('../../api/client', () => ({
  ApiClientError: class FakeApiClientError extends Error {
    code: string;
    status: number;
    correlationId: string;
    constructor(args: { code: string; message: string; status: number; correlationId: string }) {
      super(args.message);
      this.name = 'ApiClientError';
      this.code = args.code;
      this.status = args.status;
      this.correlationId = args.correlationId;
    }
  },
  api: {
    me: async () => currentMeUser(),
    updateMe: async () => ME_USER,
    logout: async () => ({ ok: true }),
    refresh: async () => ({ ...cannedSession }),
  },
}));

const { cleanup, render, screen, waitFor } = await import('@testing-library/react');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createElement, useState } = await import('react');
const { createQueryClient } = await import('../../lib/query-client');
const { I18nProvider } = await import('../../i18n');
const userEvent = (await import('@testing-library/user-event')).default;
const { HeaderProfileDropdown } = await import('../profile-dropdown');
const { ProfileDropdownUserTrigger } = await import('@web2bizz/ui/widgets');
const { setSession, clearSession } = await import('../../lib/auth-store');

// useHeaderProfile is useQuery-backed now (same PROFILE_QUERY_KEY as the
// /profile page) — every render needs a QueryClientProvider. Fresh client
// per render keeps tests isolated; within one render concurrent mounts
// share the entry (dedup 2→1 is covered in useProfile.test.tsx).
function wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return createElement(QueryClientProvider, { client }, children);
}

// Network seam stub (offline fallback; the module mock above is primary).
// Seeded per test (sign-out clears the store, so beforeEach re-seeds).
(globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
  const url = String(input);
  if (url.includes('/auth/logout')) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('/auth/me')) {
    return new Response(JSON.stringify(currentMeUser()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({ code: 'unauthorized', message: 'no stub', correlationId: 'test' }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
};

beforeEach(() => {
  setSession({ ...cannedSession });
  delete (globalThis as Record<string, unknown>).__TEST_ME_USER__;
});

afterEach(() => {
  cleanup();
  clearSession();
  pushMock.mockClear();
  delete (globalThis as Record<string, unknown>).__TEST_ME_USER__;
});

const USER = { name: 'Rush Code Developer', email: 'dev@rush-code.local' };
// Kit trigger renders AvatarFallback initial ("D") + visible displayName, so
// the accessible name concatenates ("DRush Code Developer"). Match by substring.
const TRIGGER_NAME = /Rush Code Developer/;
const FIND_TIMEOUT = 5000;

describe('ProfileDropdownUserTrigger rest/ref forward (0.25.9 regression)', () => {
  test('forwards Radix Slot props (onClick/aria/data-*) and ref to the <button>', async () => {
    const onClick = mock(() => {});
    let node: unknown = null;

    render(
      <ProfileDropdownUserTrigger
        user={USER}
        aria-label="Open user menu"
        aria-haspopup="menu"
        data-state="open"
        data-testid="kit-trigger"
        onClick={onClick}
        ref={(el) => {
          node = el;
        }}
      />,
    );

    const btn = screen.getByTestId('kit-trigger');
    expect(btn.tagName).toBe('BUTTON');
    // Old trigger dropped every prop above: getAttribute → null, ref → null,
    // click → noop. Each assertion below fails on 0.25.9.
    expect(btn.getAttribute('aria-label')).toBe('Open user menu');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('data-state')).toBe('open');
    expect(node).toBe(btn);

    const user = userEvent.setup();
    await user.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('HeaderProfileDropdown (pure kit AuthorizedUserProfile)', () => {
  test('closed trigger exposes menu semantics; click opens with profile + sign-out', async () => {
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />, { wrapper });

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    // Radix Slot props must reach the kit trigger (the 0.25.9 bug: they did not).
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('data-state')).toBe('closed');
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger);

    await screen.findByRole('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('data-state')).toBe('open');
    // NOTE: kit Action renders native link/button without role=menuitem
    // (Slot props dropped on its plain function component — kit follow-up).
    const profile = screen.getByRole('link', { name: 'Profile' });
    expect(profile.getAttribute('href')).toBe('/profile');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });

  test('sign-out pushes /login', async () => {
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />, { wrapper });

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(pushMock).toHaveBeenCalledWith('/login');
  });

  test('Escape closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />, { wrapper });

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  test('keyboard: Tab moves focus into the open menu (arrows roving pending kit fix)', async () => {
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />, { wrapper });

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    const menu = await screen.findByRole('menu');

    // Sequential keyboard reachability works: Tab lands inside the menu,
    // menu stays open, Escape from there still closes it.
    // NOTE: ArrowUp/Down/Home/End roving is broken kit-side — desktop
    // ProfileDropdown.Action wraps a plain function component in
    // DropdownMenuItem asChild, so Slot drops item refs and Radix
    // focusFirst crashes on null (kit follow-up, not this task).
    trigger.focus();
    await user.tab();
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  test('ru locale renders translated labels', async () => {
    document.cookie = 'rush-code-locale=ru; path=/';
    try {
      const user = userEvent.setup();
      render(
        <I18nProvider>
          <HeaderProfileDropdown />
        </I18nProvider>,
        { wrapper },
      );

      const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
      await user.click(trigger);

      await screen.findByRole('menu');
      expect(screen.getByRole('link', { name: 'Профиль' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Выйти' })).toBeDefined();
    } finally {
      document.cookie = 'rush-code-locale=; path=/; max-age=0';
    }
  });
});

describe('HeaderProfileDropdown limits (daily/weekly/monthly)', () => {
  test('renders 3 limits with values and progress (en)', async () => {
    (globalThis as Record<string, unknown>).__TEST_ME_USER__ = ME_USER_WITH_LIMITS;
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />);

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    const group = await screen.findByTestId('profile-limits');
    expect(group.getAttribute('aria-label')).toBe('Usage limits');
    expect(screen.getByTestId('profile-limits-title').textContent).toBe('Usage limits');

    expect(screen.getByTestId('profile-limit-daily-label').textContent).toBe('Daily');
    expect(screen.getByTestId('profile-limit-daily-value').textContent).toBe('5 / 100');
    expect(screen.getByTestId('profile-limit-weekly-label').textContent).toBe('Weekly');
    expect(screen.getByTestId('profile-limit-weekly-value').textContent).toBe('20 / 500');
    expect(screen.getByTestId('profile-limit-monthly-label').textContent).toBe('Monthly');
    expect(screen.getByTestId('profile-limit-monthly-value').textContent).toBe('100 / 2000');

    // Simple progress: used/total % as aria-valuenow (5%, 4%, 5%).
    expect(screen.getByTestId('profile-limit-daily-progress').getAttribute('aria-valuenow')).toBe('5');
    expect(screen.getByTestId('profile-limit-weekly-progress').getAttribute('aria-valuenow')).toBe('4');
    expect(screen.getByTestId('profile-limit-monthly-progress').getAttribute('aria-valuenow')).toBe('5');

    // Old cases still hold alongside limits.
    expect(screen.getByRole('link', { name: 'Profile' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });

  test('hides limits group when backend sends no quota', async () => {
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />);

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    expect(screen.queryByTestId('profile-limits')).toBeNull();
    expect(screen.getByRole('link', { name: 'Profile' })).toBeDefined();
  });

  test('ru locale renders translated limit labels', async () => {
    (globalThis as Record<string, unknown>).__TEST_ME_USER__ = ME_USER_WITH_LIMITS;
    document.cookie = 'devbox-locale=ru; path=/';
    try {
      const user = userEvent.setup();
      render(
        <I18nProvider>
          <HeaderProfileDropdown />
        </I18nProvider>,
      );

      const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
      await user.click(trigger);
      await screen.findByRole('menu');

      expect(screen.getByTestId('profile-limits-title').textContent).toBe('Лимиты использования');
      expect(screen.getByTestId('profile-limit-daily-label').textContent).toBe('Дневной');
      expect(screen.getByTestId('profile-limit-daily-value').textContent).toBe('5 / 100');
      expect(screen.getByTestId('profile-limit-weekly-label').textContent).toBe('Недельный');
      expect(screen.getByTestId('profile-limit-weekly-value').textContent).toBe('20 / 500');
      expect(screen.getByTestId('profile-limit-monthly-label').textContent).toBe('Месячный');
      expect(screen.getByTestId('profile-limit-monthly-value').textContent).toBe('100 / 2000');
      expect(screen.getByRole('link', { name: 'Профиль' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Выйти' })).toBeDefined();
    } finally {
      document.cookie = 'devbox-locale=; path=/; max-age=0';
    }
  });

  test('partial limits render only the present bucket', async () => {
    (globalThis as Record<string, unknown>).__TEST_ME_USER__ = {
      ...ME_USER,
      limits: { daily: { used: 7, total: 10 } },
    };
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />);

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    expect(screen.getByTestId('profile-limits')).toBeDefined();
    expect(screen.getByTestId('profile-limit-daily-value').textContent).toBe('7 / 10');
    expect(screen.getByTestId('profile-limit-daily-progress').getAttribute('aria-valuenow')).toBe('70');
    expect(screen.queryByTestId('profile-limit-weekly')).toBeNull();
    expect(screen.queryByTestId('profile-limit-monthly')).toBeNull();
  });

  test('total=0 renders 0% without NaN', async () => {
    (globalThis as Record<string, unknown>).__TEST_ME_USER__ = {
      ...ME_USER,
      limits: { daily: { used: 0, total: 0 } },
    };
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />);

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    expect(screen.getByTestId('profile-limit-daily-value').textContent).toBe('0 / 0');
    expect(screen.getByTestId('profile-limit-daily-progress').getAttribute('aria-valuenow')).toBe('0');
  });

  test('over-quota clamps progress to 100', async () => {
    (globalThis as Record<string, unknown>).__TEST_ME_USER__ = {
      ...ME_USER,
      limits: { monthly: { used: 2500, total: 2000 } },
    };
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />);

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    expect(screen.getByTestId('profile-limit-monthly-value').textContent).toBe('2500 / 2000');
    expect(screen.getByTestId('profile-limit-monthly-progress').getAttribute('aria-valuenow')).toBe('100');
    expect(screen.queryByTestId('profile-limit-daily')).toBeNull();
  });

  test('negative used clamps progress to 0', async () => {
    (globalThis as Record<string, unknown>).__TEST_ME_USER__ = {
      ...ME_USER,
      limits: { weekly: { used: -5, total: 100 } },
    };
    const user = userEvent.setup();
    render(<HeaderProfileDropdown />);

    const trigger = await screen.findByRole('button', { name: TRIGGER_NAME }, { timeout: FIND_TIMEOUT });
    await user.click(trigger);
    await screen.findByRole('menu');

    expect(screen.getByTestId('profile-limit-weekly-value').textContent).toBe('-5 / 100');
    expect(screen.getByTestId('profile-limit-weekly-progress').getAttribute('aria-valuenow')).toBe('0');
  });
});
