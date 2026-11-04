/**
 * SessionsSidebar / SessionList — the chat list lives in the sidebar.
 *
 * Covers: non-session project routes keep the plain SidebarNav, `/sessions`
 * and `/sessions/[sessionId]` swap it for the chat list, rows link to the
 * session chat and mark the open chat with aria-current="page", the title is
 * the visible line with a localized untitled fallback, and the create action
 * routes to the new session.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

const ORG = 'org-1';
const PRJ = '123e4567-e89b-12d3-a456-426614174090';
const BASE = `/organizations/${ORG}/projects/${PRJ}`;

let currentPath = `${BASE}/secrets`;
const pushMock = mock((_href: string) => {});
mock.module('next/navigation', () => ({
  usePathname: () => currentPath,
  useRouter: () => ({ push: pushMock }),
}));

const iso = (ms: number) => new Date(ms).toISOString();
const sessionInfo = (id: string, title: string | null) => ({
  id,
  title,
  createdAt: iso(1700000000000),
  directory: `/srv/projects/${PRJ}`,
  projectId: PRJ,
  model: null,
  agentId: null,
  status: { type: 'idle' as const },
});

const createMock = mock(async (_title?: string) => sessionInfo('ses-new', 'new'));
const abortMock = mock(async (_id: string) => {});
const reloadMock = mock(() => {});

mock.module('../../../hooks/useSessions', () => ({
  useSessions: () => ({
    sessions: [sessionInfo('ses-1', 'first'), sessionInfo('ses-2', null)],
    statusMap: {},
    loading: false,
    error: null,
    isEmpty: false,
    reload: reloadMock,
    create: createMock,
    creating: false,
    abort: abortMock,
    abortingId: null,
  }),
}));

const { cleanup, render, screen, fireEvent } = await import('@testing-library/react');
const { I18nProvider } = await import('../../../i18n');
const { SessionsSidebar } = await import('../sessions-sidebar');

const items = [
  { href: BASE, label: 'Overview' },
  { href: `${BASE}/sessions`, label: 'Sessions' },
  { href: `${BASE}/secrets`, label: 'Secrets' },
];

afterEach(() => {
  cleanup();
  currentPath = `${BASE}/secrets`;
  pushMock.mockClear();
  createMock.mockClear();
});

function setup() {
  return render(
    <I18nProvider>
      <SessionsSidebar orgId={ORG} projectId={PRJ} items={items} />
    </I18nProvider>,
  );
}

describe('SessionsSidebar', () => {
  test('non-session route keeps the project nav (no chat list)', () => {
    setup();
    expect(screen.getByRole('link', { name: 'Secrets' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Chats' })).toBeNull();
  });

  test('/sessions swaps the nav for the chat list', () => {
    currentPath = `${BASE}/sessions`;
    setup();
    expect(screen.getByRole('heading', { name: 'Chats' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Secrets' })).toBeNull();
    // No open chat yet → nothing is current.
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });

  test('chat route links rows and marks the open session as current', () => {
    currentPath = `${BASE}/sessions/ses-1`;
    setup();

    const first = screen.getByRole('link', { name: 'Open session first' });
    expect(first.getAttribute('href')).toBe(`${BASE}/sessions/ses-1`);
    expect(first.getAttribute('aria-current')).toBe('page');

    // title === null → dictionary fallback, never the raw id.
    const untitled = screen.getByRole('link', { name: 'Open session Untitled' });
    expect(untitled.getAttribute('href')).toBe(`${BASE}/sessions/ses-2`);
    expect(untitled.getAttribute('aria-current')).toBeNull();
    expect(screen.queryByText('ses-2')).toBeNull();
  });

  test('create action routes to the new session chat', async () => {
    currentPath = `${BASE}/sessions`;
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    await screen.findByRole('link', { name: 'Open session first' });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith(`${BASE}/sessions/ses-new`);
  });
});
