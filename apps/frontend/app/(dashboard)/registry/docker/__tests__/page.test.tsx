/**
 * /registry/docker page — flat list over the live catalog proxy.
 * Moved from /registries (redirect kept in next.config.mjs).
 *
 * Covers: loading skeleton, live rows (name/Badge/repo count + catalog
 * always visible, no dropdown), search filtering with no-matches,
 * 503 error + retry refetch (repos visible immediately), empty catalog
 * → EmptyState. The api client is mocked (same specifier the hook
 * imports); the page and the real useRegistries run unmocked
 * underneath. fireEvent (not userEvent) keeps the suite inside bun's
 * 5s per-test budget.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

class FakeApiClientError extends Error {
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
}

let catalogImpl: () => Promise<{ repositories: string[] }> = async () => ({
  repositories: ['library/nginx', 'team/app'],
});
const catalogMock = mock(() => catalogImpl());

mock.module('../../../../../src/api/client', () => ({
  ApiClientError: FakeApiClientError,
  api: {
    baseUrl: 'http://localhost:3000',
    apiVersion: 'v1',
    getRegistryCatalog: catalogMock,
  },
}));

const { cleanup, render, screen, fireEvent, waitFor } = await import(
  '@testing-library/react'
);
const { I18nProvider } = await import('../../../../../src/i18n');
const Page = (await import('../page')).default;

afterEach(() => {
  cleanup();
  catalogMock.mockClear();
  catalogImpl = async () => ({ repositories: ['library/nginx', 'team/app'] });
});

function setup() {
  return render(
    <I18nProvider>
      <Page />
    </I18nProvider>,
  );
}

async function settle() {
  await waitFor(() => {
    expect(screen.queryByLabelText(/Loading page/i)).toBeNull();
  });
}

describe('/registry/docker page', () => {
  test('loading: skeleton shows while the catalog is in flight', async () => {
    let release!: (v: { repositories: string[] }) => void;
    catalogImpl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    setup();

    expect(screen.getByLabelText(/Loading page/i)).not.toBeNull();

    release({ repositories: [] });
    await settle();
  });

  test('rows: live registry with status badge, repo count and flat catalog (no dropdown)', async () => {
    setup();
    await settle();

    expect(screen.getByText('default')).not.toBeNull();
    expect(screen.getByText('up')).not.toBeNull();
    expect(screen.getByText(/2 .*repositories/i)).not.toBeNull();

    // Catalog is flat — repos visible without any click.
    expect(screen.getByText('library/nginx')).not.toBeNull();
    expect(screen.getByText('team/app')).not.toBeNull();

    // No dropdown buttons remain.
    expect(screen.queryByRole('button', { name: /Show catalog/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Hide catalog/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Показать каталог/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Скрыть каталог/i })).toBeNull();
  });

  test('search: filters rows and shows no-matches for unknown query', async () => {
    setup();
    await settle();

    const search = screen.getByLabelText(/Search/i);
    fireEvent.change(search, { target: { value: 'zzz-no-such-repo' } });
    expect(screen.getByText(/No matches/i)).not.toBeNull();

    fireEvent.change(search, { target: { value: 'nginx' } });
    expect(screen.getByText('default')).not.toBeNull();
    expect(screen.getByText('library/nginx')).not.toBeNull();
  });

  test('empty: catalogEmpty EmptyState when no repositories', async () => {
    catalogImpl = async () => ({ repositories: [] });
    setup();
    await settle();

    expect(screen.getByText('default')).not.toBeNull();
    expect(screen.getByText(/Catalog is empty/i)).not.toBeNull();
  });

  test('503: error with retry refetches the catalog (repos visible at once)', async () => {
    catalogImpl = async () => {
      throw new FakeApiClientError({
        code: 'EXTERNAL_UNAVAILABLE',
        message: 'registry unreachable',
        status: 503,
        correlationId: 'corr-1',
      });
    };
    setup();
    await settle();

    expect(screen.getByText(/EXTERNAL_UNAVAILABLE/i)).not.toBeNull();

    catalogImpl = async () => ({ repositories: ['library/redis'] });
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    await waitFor(() => {
      expect(screen.getByText('default')).not.toBeNull();
    });
    // Flat catalog — no Show click needed.
    expect(screen.getByText('library/redis')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Show catalog/i })).toBeNull();
  });
});
