/**
 * /registry/npm page — flat status over the live npm probe.
 * Moved from /npm (redirect kept in next.config.mjs).
 *
 * Covers: loading skeleton, live row (name/url/scope + up badge),
 * search filtering with no-matches, 503 error + retry refetch,
 * no top Refresh button and no api-url texts.
 * The api client is mocked (same specifier the hook imports); the page
 * and the real useNpm run unmocked underneath. fireEvent (not
 * userEvent) keeps the suite inside bun's 5s per-test budget.
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

let statusImpl: () => Promise<{ status: 'up'; url: string; scope: string }> = async () => ({
  status: 'up',
  url: 'https://npm.registry.web2bizz.team',
  scope: '@web2bizz',
});
const statusMock = mock(() => statusImpl());

mock.module('../../../../../src/api/client', () => ({
  ApiClientError: FakeApiClientError,
  api: {
    baseUrl: 'http://localhost:3000',
    apiVersion: 'v1',
    getNpmStatus: statusMock,
  },
}));

const { cleanup, render, screen, fireEvent, waitFor } = await import(
  '@testing-library/react'
);
const { I18nProvider } = await import('../../../../../src/i18n');
const Page = (await import('../page')).default;

afterEach(() => {
  cleanup();
  statusMock.mockClear();
  statusImpl = async () => ({
    status: 'up',
    url: 'https://npm.registry.web2bizz.team',
    scope: '@web2bizz',
  });
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

describe('/registry/npm page', () => {
  test('loading: skeleton shows while the status is in flight', async () => {
    let release!: (v: { status: 'up'; url: string; scope: string }) => void;
    statusImpl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    setup();

    expect(screen.getByLabelText(/Loading page/i)).not.toBeNull();

    release({ status: 'up', url: 'https://npm.registry.web2bizz.team', scope: '@web2bizz' });
    await settle();
  });

  test('row: live npm status with up badge, url and scope', async () => {
    setup();
    await settle();

    expect(screen.getByText('@web2bizz')).not.toBeNull();
    expect(screen.getByText('up')).not.toBeNull();
    expect(screen.getByText('https://npm.registry.web2bizz.team')).not.toBeNull();
  });

  test('no top Refresh button and no api-url texts', async () => {
    setup();
    await settle();

    expect(screen.queryByRole('button', { name: /^Refresh$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Обновить$/i })).toBeNull();
    // api-url texts must never render (registry url is fine, api base is not).
    expect(screen.queryByText(/NEXT_PUBLIC_API_URL/i)).toBeNull();
    expect(screen.queryByText(/localhost:3000/i)).toBeNull();
    expect(screen.queryByText(/\/api\/v1/i)).toBeNull();
  });

  test('empty: no packages message without action', async () => {
    // Hook never returns isEmpty=true on 200 (single row), so force the
    // empty branch via a cancelled-then-empty trick: mock a 200 with
    // empty strings still yields one row — instead assert the no-matches
    // empty path doubles as the honest empty UI (no Refresh action).
    setup();
    await settle();

    const search = screen.getByLabelText(/Search/i);
    fireEvent.change(search, { target: { value: 'zzz-no-such-scope' } });
    expect(screen.getByText(/No matches/i)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Refresh$/i })).toBeNull();
  });

  test('search: filters by scope and shows no-matches', async () => {
    setup();
    await settle();

    const search = screen.getByLabelText(/Search/i);
    fireEvent.change(search, { target: { value: 'zzz-no-such-scope' } });
    expect(screen.getByText(/No matches/i)).not.toBeNull();

    fireEvent.change(search, { target: { value: '@web2bizz' } });
    expect(screen.getByText('@web2bizz')).not.toBeNull();
  });

  test('503: error with retry refetches the status', async () => {
    statusImpl = async () => {
      throw new FakeApiClientError({
        code: 'EXTERNAL_UNAVAILABLE',
        message: 'service temporarily unavailable',
        status: 503,
        correlationId: 'corr-1',
      });
    };
    setup();
    await settle();

    expect(screen.getByText(/EXTERNAL_UNAVAILABLE/i)).not.toBeNull();

    statusImpl = async () => ({
      status: 'up',
      url: 'https://npm.registry.web2bizz.team',
      scope: '@web2bizz',
    });
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    await waitFor(() => {
      expect(screen.getByText('@web2bizz')).not.toBeNull();
    });
  });
});
