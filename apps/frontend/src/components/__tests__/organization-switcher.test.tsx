/**
 * OrganizationSwitcher — org dropdown next to the logo (kit `components`
 * entry DropdownMenu primitives + native <button> trigger styled via kit
 * `buttonVariants`, same ref-forward-safe pattern as LanguageSwitcher).
 *
 * Covers: authenticated renders trigger with active org from pathname,
 * selecting another org pushes /organizations/[id], empty list renders a
 * Link to /organizations, guests render nothing (useHeaderProfile gate).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
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

const ORG_1 = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'acme',
  description: null,
  ownerId: null,
  isPrivate: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const ORG_2 = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'globex',
  description: null,
  ownerId: null,
  isPrivate: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const ME_USER = {
  id: 'mock-user-1',
  firstName: 'Rush Code',
  lastName: 'Developer',
  email: 'dev@rush-code.local',
  provider: 'local' as const,
  createdAt: '2026-01-15T09:00:00.000Z',
};

let currentPath = '/organizations';
let listImpl: () => Promise<typeof ORG_1[]> = async () => [ORG_1, ORG_2];
let meImpl: () => Promise<typeof ME_USER> = async () => ME_USER;

const pushMock = mock((_href: string) => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => currentPath,
}));

const listMock = mock(() => listImpl());
const meMock = mock(() => meImpl());

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
  api: { me: meMock, listOrganizations: listMock },
}));

mock.module('../../lib/auth-store', () => ({
  getValidAccessToken: async () => 'test-token',
  refreshAccessToken: async () => 'test-token',
}));

const { cleanup, render, screen, waitFor } = await import('@testing-library/react');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createElement, useState } = await import('react');
const { createQueryClient } = await import('../../lib/query-client');
const { I18nProvider } = await import('../../i18n');
const userEvent = (await import('@testing-library/user-event')).default;
const { OrganizationSwitcher } = await import('../organization-switcher');

function wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return createElement(
    QueryClientProvider,
    { client },
    createElement(I18nProvider, null, children),
  );
}

afterEach(() => {
  cleanup();
  pushMock.mockClear();
  listMock.mockClear();
  meMock.mockClear();
  currentPath = '/organizations';
  listImpl = async () => [ORG_1, ORG_2];
  meImpl = async () => ME_USER;
});

const FIND_TIMEOUT = 5000;

describe('OrganizationSwitcher', () => {
  test('authenticated: trigger shows active org from pathname', async () => {
    currentPath = `/organizations/${ORG_1.id}`;
    render(createElement(OrganizationSwitcher), { wrapper });

    const trigger = await screen.findByRole('button', { name: 'Organizations' }, { timeout: FIND_TIMEOUT });
    await waitFor(() => expect(trigger.textContent).toContain('acme'));
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  });

  test('selecting another org pushes /organizations/[id]', async () => {
    currentPath = `/organizations/${ORG_1.id}`;
    const user = userEvent.setup();
    render(createElement(OrganizationSwitcher), { wrapper });

    const trigger = await screen.findByRole('button', { name: 'Organizations' }, { timeout: FIND_TIMEOUT });
    await waitFor(() => expect(trigger.textContent).toContain('acme'));
    await user.click(trigger);
    await screen.findByRole('menu');

    const globex = screen.getByRole('menuitemradio', { name: 'globex' });
    expect(globex.getAttribute('aria-checked')).toBe('false');
    const acme = screen.getByRole('menuitemradio', { name: 'acme' });
    expect(acme.getAttribute('aria-checked')).toBe('true');

    await user.click(globex);
    expect(pushMock).toHaveBeenCalledWith(`/organizations/${ORG_2.id}`);
  });

  test('empty: renders a link to /organizations', async () => {
    listImpl = async () => [];
    render(createElement(OrganizationSwitcher), { wrapper });

    const link = await screen.findByRole('link', { name: 'Organizations' }, { timeout: FIND_TIMEOUT });
    expect(link.getAttribute('href')).toBe('/organizations');
  });

  test('guest (no profile): renders nothing', async () => {
    meImpl = async () => {
      throw new Error('session-expired');
    };
    const { container } = render(createElement(OrganizationSwitcher), { wrapper });
    await waitFor(() => expect(meMock).toHaveBeenCalled());
    // Fail-closed gate: guests see neither trigger nor hub link.
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
