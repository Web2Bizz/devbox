/**
 * Sidebar registries group — expandable dropdown with direct leaf links.
 *
 * Covers: collapsed by default, expands on click (aria-expanded) to
 * "Docker images" (→ /registry/docker) + "Npm packages" (→ /registry/npm)
 * sub-links with hrefs (no /registry hub link — hubs stay outside the
 * Sidebar, reachable by direct URL, rule for storages/databases), active
 * state on /registry/docker, Escape collapses the group. fireEvent
 * (not userEvent) keeps the suite inside bun's 5s per-test budget.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

let currentPath = '/projects';
mock.module('next/navigation', () => ({
  usePathname: () => currentPath,
  useRouter: () => ({ push: mock(() => {}) }),
}));

const { cleanup, render, screen, fireEvent } = await import('@testing-library/react');
const { I18nProvider } = await import('../../../i18n');
const { SidebarNav } = await import('../Sidebar');

afterEach(() => {
  cleanup();
  currentPath = '/projects';
});

function setup() {
  return render(
    <I18nProvider>
      <SidebarNav />
    </I18nProvider>,
  );
}

describe('Sidebar registries dropdown', () => {
  test('collapsed by default, expands to docker + npm links (no hub)', async () => {
    setup();

    const group = screen.getByRole('button', { name: /Registries/i });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: /Docker images/i })).toBeNull();

    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');

    expect(screen.queryByRole('link', { name: /All registries/i })).toBeNull();

    const link = screen.getByRole('link', { name: /Docker images/i });
    expect(link.getAttribute('href')).toBe('/registry/docker');

    const npm = screen.getByRole('link', { name: /Npm packages/i });
    expect(npm.getAttribute('href')).toBe('/registry/npm');
  });

  test('active state on /registry/docker (aria-current + data-active)', async () => {
    currentPath = '/registry/docker';
    setup();

    fireEvent.click(screen.getByRole('button', { name: /Registries/i }));
    const link = screen.getByRole('link', { name: /Docker images/i });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.getAttribute('data-active')).toBe('true');
  });

  test('Escape collapses the open group', async () => {
    setup();

    const group = screen.getByRole('button', { name: /Registries/i });
    fireEvent.click(group);
    expect(screen.getByRole('link', { name: /Docker images/i })).not.toBeNull();

    fireEvent.keyDown(group, { key: 'Escape' });
    expect(group.getAttribute('aria-expanded')).toBe('false');
  });

  test('ru locale renders Docker-образы link (no hub)', async () => {
    document.cookie = 'rush-code-locale=ru; path=/';
    try {
      setup();

      const group = await screen.findByRole('button', {
        name: /Реестры/i,
      });
      fireEvent.click(group);

      const link = await screen.findByRole('link', {
        name: /Docker-образы/i,
      });
      expect(link.getAttribute('href')).toBe('/registry/docker');

      expect(screen.queryByRole('link', { name: /Все реестры/i })).toBeNull();
    } finally {
      document.cookie = 'rush-code-locale=; path=/; max-age=0';
      try {
        window.localStorage.removeItem('rush-code-locale');
      } catch {
        // private mode / blocked storage — ignore
      }
    }
  });
});
