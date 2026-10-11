/**
 * /registry hub page — two Card links (Docker → /registry/docker,
 * npm → /registry/npm) over the reusable RegistryHub.
 *
 * Covers: h1 from t.registry.*, both links with hrefs (en), ru locale
 * renders Docker-образы + Npm-пакеты links. No data fetching — pure
 * i18n render. fireEvent-free (no userEvent) keeps the suite inside
 * bun's 5s per-test budget.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

const { cleanup, render, screen } = await import('@testing-library/react');
const { I18nProvider } = await import('../../../../src/i18n');
const Page = (await import('../page')).default;

afterEach(() => {
  cleanup();
});

function setup() {
  return render(
    <I18nProvider>
      <Page />
    </I18nProvider>,
  );
}

describe('/registry hub page', () => {
  test('h1 + two links to docker and npm (en)', async () => {
    setup();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
      /Registry/i,
    );

    const docker = screen.getByRole('link', { name: /Docker images/i });
    expect(docker.getAttribute('href')).toBe('/registry/docker');

    const npm = screen.getByRole('link', { name: /Npm packages/i });
    expect(npm.getAttribute('href')).toBe('/registry/npm');
  });

  test('ru locale renders Docker-образы + Npm-пакеты links', async () => {
    document.cookie = 'devbox-locale=ru; path=/';
    try {
      setup();

      const docker = await screen.findByRole('link', {
        name: /Docker-образы/i,
      });
      expect(docker.getAttribute('href')).toBe('/registry/docker');

      const npm = await screen.findByRole('link', {
        name: /Npm-пакеты/i,
      });
      expect(npm.getAttribute('href')).toBe('/registry/npm');
    } finally {
      document.cookie = 'devbox-locale=; path=/; max-age=0';
      try {
        window.localStorage.removeItem('devbox-locale');
      } catch {
        // private mode / blocked storage — ignore
      }
    }
  });
});
