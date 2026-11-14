/**
 * ChatSection URL persist (C5): sessionId lives in the path, `?agent=`
 * carries the agent picker. The hook stays router-free — all URL sync
 * lives here, so these tests mock `useChat` + `next/navigation` and assert
 * the sync contract:
 * - init: `?agent=<id>` → setAgentId(id); absent/empty → default, no call;
 * - sync: agentId change → router.replace(path + ?agent=, {scroll:false});
 * - default agent → the param is dropped, never `?agent=ask` spam;
 * - hostile values pass through raw (no client-side validation — the
 *   backend answers an honest 404 on unknown agents).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

// ---- next/navigation mock (capture replace, fixed pathname) ----------------
const replaced: Array<{ url: string; opts?: unknown }> = [];
const PATHNAME = '/orgs/o1/projects/p1/sessions';

mock.module('next/navigation', () => ({
  useRouter: () => ({
    replace: (url: string, opts?: unknown) => {
      replaced.push({ url, opts });
    },
    push: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
  }),
  usePathname: () => PATHNAME,
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(''),
}));

// ---- domain client mock (registry only; the hook is mocked below) ----------
mock.module('../../api/sessions-client', () => ({
  DEFAULT_AGENT_ID: 'ask',
  listAgents: async () => [],
}));

// ---- useChat mock (router-free hook: controllable holder) -------------------
const chatHolder: { agentId: string; sessionId: string | null } = {
  agentId: 'ask',
  sessionId: null,
};
const setAgentCalls: Array<string> = [];

mock.module('../../hooks/useChat', () => ({
  useChat: () => ({
    messages: [],
    entries: [],
    leafId: null,
    loading: false,
    sending: false,
    error: null,
    isEmpty: true,
    sessionId: chatHolder.sessionId,
    agentId: chatHolder.agentId,
    setAgentId: (id: string) => {
      setAgentCalls.push(id);
    },
    activeAgentId: null,
    activeToolName: null,
    activeLeaf: null,
    variants: [],
    variantIndex: 0,
    variantCount: 0,
    selectLeaf: () => {},
    revertTo: () => {},
    revertMessages: async () => {},
    send: async () => {},
    stop: () => {},
    reload: () => {},
  }),
}));

// ---- fork/revert dialogs (heavy, irrelevant when closed) --------------------
mock.module('../chat-fork-dialog', () => ({
  ChatForkDialog: () => null,
}));
mock.module('../chat-revert-dialog', () => ({
  ChatRevertDialog: () => null,
}));

const { cleanup, render } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { I18nProvider } = await import('../../i18n');
const { ChatSection } = await import('../chat-section');

function setQuery(qs: string): void {
  window.history.replaceState({}, '', qs ? `${PATHNAME}${qs}` : PATHNAME);
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ChatSection projectId="00000000-0000-0000-0000-000000000001" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  replaced.length = 0;
  setAgentCalls.length = 0;
  chatHolder.agentId = 'ask';
  chatHolder.sessionId = null;
  setQuery('');
});

describe('ChatSection ?agent= persist', () => {
  test('init: ?agent= seeds the picker via setAgentId', async () => {
    setQuery('?agent=eva');
    renderSection();
    expect(setAgentCalls).toEqual(['eva']);
  });

  test('init fallback: no ?agent= leaves the default untouched (no call)', async () => {
    setQuery('');
    renderSection();
    expect(setAgentCalls).toEqual([]);
  });

  test('init fallback: empty ?agent= is not a value (no call)', async () => {
    setQuery('?agent=');
    renderSection();
    expect(setAgentCalls).toEqual([]);
  });

  test('init: hostile ?agent= passes through raw (validation is the backend gate)', async () => {
    setQuery('?agent=a%20b%2Fc');
    renderSection();
    expect(setAgentCalls).toEqual(['a b/c']);
  });

  test('sync: non-default agentId writes ?agent= via replace (no scroll)', async () => {
    setQuery('');
    chatHolder.agentId = 'eva';
    renderSection();
    expect(replaced.length).toBe(1);
    expect(replaced[0]?.url).toBe(`${PATHNAME}?agent=eva`);
    expect(replaced[0]?.opts).toMatchObject({ scroll: false });
  });

  test('sync: default agentId drops ?agent= instead of spamming ?agent=ask', async () => {
    setQuery('?agent=custom');
    chatHolder.agentId = 'ask';
    renderSection();
    // Init still offers the URL value to the picker…
    expect(setAgentCalls).toEqual(['custom']);
    // …but the stored default cleans the param (replace without query).
    expect(replaced.length).toBe(1);
    expect(replaced[0]?.url).toBe(PATHNAME);
  });

  test('sync: already-matching ?agent= never replaces (no loop)', async () => {
    setQuery('?agent=eva');
    chatHolder.agentId = 'eva';
    renderSection();
    // Init is a no-op (equal), sync guard matches — zero replaces.
    expect(setAgentCalls).toEqual([]);
    expect(replaced).toEqual([]);
  });

  test('sync: unrelated query params survive the agent write', async () => {
    setQuery('?tab=info');
    chatHolder.agentId = 'eva';
    renderSection();
    expect(replaced.length).toBe(1);
    const url = replaced[0]?.url ?? '';
    expect(url).toContain('agent=eva');
    expect(url).toContain('tab=info');
  });
});
