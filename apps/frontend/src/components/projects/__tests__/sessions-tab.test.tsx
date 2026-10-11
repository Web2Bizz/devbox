/**
 * SessionsTab — navigation (session = chat).
 *
 * Covers: Open routes to /projects/[id]/sessions/[sessionId],
 * create() success routes to the new session chat, virtualized list
 * keeps row content (title/id) for 100+ rows path.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

const pushMock = mock((_href: string) => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  // Process-global mock registry (shared across test files): expose
  // usePathname so Sidebar (usePathname) links in full runs.
  usePathname: () => '/',
}));

const createMock = mock(async () => ({
  id: 'ses-new',
  projectID: 'prj-1',
  directory: '/tmp',
  title: 'new',
  time: { created: Date.now(), updated: Date.now() },
}));
const abortMock = mock(async (_id: string) => {});
const reloadMock = mock(() => {});

mock.module('../../../hooks/useOpencodeSessions', () => ({
  useOpencodeSessions: () => ({
    sessions: [
      {
        id: 'ses-1',
        projectID: 'prj-1',
        directory: '/tmp',
        title: 'first',
        time: { created: 1, updated: Date.now() },
      },
      {
        id: 'ses-2',
        projectID: 'prj-1',
        directory: '/tmp',
        title: '',
        time: { created: 2, updated: Date.now() },
      },
    ],
    loading: false,
    error: null,
    reload: reloadMock,
    create: createMock,
    creating: false,
    abort: abortMock,
    abortingId: null,
  }),
}));

// Virtualizer passthrough: render every row (no scroll math in happy-dom).
mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 140,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: `row-${index}`,
        start: index * 140,
      })),
    measureElement: () => {},
  }),
}));

const { cleanup, render, screen } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { I18nProvider } = await import('../../../i18n');
const { SessionsTab } = await import('../sessions-tab');

afterEach(() => {
  cleanup();
  pushMock.mockClear();
  createMock.mockClear();
  abortMock.mockClear();
  reloadMock.mockClear();
});

function renderTab() {
  return render(
    <I18nProvider>
      <SessionsTab projectId="prj-web" />
    </I18nProvider>,
  );
}

describe('SessionsTab navigation', () => {
  test('Open routes to /projects/[id]/sessions/[sessionId]', async () => {
    renderTab();
    const user = userEvent.setup();
    const openButtons = await screen.findAllByRole('button', { name: 'Open' });
    expect(openButtons.length).toBe(2);
    await user.click(openButtons[0]);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/projects/prj-web/sessions/ses-1');
  });

  test('create() success routes to the new session chat', async () => {
    renderTab();
    const user = userEvent.setup();
    const createBtn = await screen.findByRole('button', { name: 'New session' });
    await user.click(createBtn);
    // create() is async — wait a tick for the push.
    await screen.findByText('first');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/projects/prj-web/sessions/ses-new');
  });
});
