/**
 * Gone global (410) — this surface moved under the organization/project.
 * Covers: h1 410, CTA link to /organizations (no org guess).
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

describe('gone global 410', () => {
  test('h1 410 + CTA to /organizations', async () => {
    render(
      <I18nProvider>
        <Page />
      </I18nProvider>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/410/);
    const cta = screen.getByRole('link', { name: /organizations/i });
    expect(cta.getAttribute('href')).toBe('/organizations');
  });
});
