/**
 * Sidebar registries group — npm sub-link (/registry/npm).
 *
 * Covers: group expands to Docker images (/registry/docker) and Npm packages
 * (/registry/npm) links (no /registry hub — hubs stay outside the Sidebar,
 * reachable by direct URL), active state on /registry/npm, ru locale renders
 * Npm-пакеты. fireEvent (not userEvent) keeps the suite inside bun's 5s
 * per-test budget.
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

describe('Sidebar npm sub-link', () => {
  test('expands to Docker images + Npm packages links (no hub)', async () => {
    setup();

    const group = screen.getByRole('button', { name: /Registries/i });
    fireEvent.click(group);

    expect(screen.queryByRole('link', { name: /All registries/i })).toBeNull();

    const docker = screen.getByRole('link', { name: /Docker images/i });
    expect(docker.getAttribute('href')).toBe('/registry/docker');

    const npm = screen.getByRole('link', { name: /Npm packages/i });
    expect(npm.getAttribute('href')).toBe('/registry/npm');
  });

  test('active state on /registry/npm (aria-current + data-active)', async () => {
    currentPath = '/registry/npm';
    setup();

    fireEvent.click(screen.getByRole('button', { name: /Registries/i }));
    const link = screen.getByRole('link', { name: /Npm packages/i });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.getAttribute('data-active')).toBe('true');
  });

  test('ru locale renders Npm-пакеты link', async () => {
    document.cookie = 'rush-code-locale=ru; path=/';
    try {
      setup();

      const group = await screen.findByRole('button', {
        name: /Реестры/i,
      });
      fireEvent.click(group);

      const link = await screen.findByRole('link', {
        name: /Npm-пакеты/i,
      });
      expect(link.getAttribute('href')).toBe('/registry/npm');
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
