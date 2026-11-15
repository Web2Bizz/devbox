import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ChatEntry } from '../../../../lib/chat-chain';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

const { cleanup, render, screen } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { ChatThread } = await import('..');
const { buildThreadRows } = await import('../../../../lib/chat-chain');
const { I18nProvider } = await import('../../../../i18n');

afterEach(() => {
  cleanup();
});

function renderThread(props?: Partial<Parameters<typeof ChatThread>[0]>) {
  return render(
    <I18nProvider>
      <ChatThread messages={[]} streamingText="" {...props} />
    </I18nProvider>,
  );
}

const T0 = 1700000000000;
const entry = (
  id: string,
  text: string,
  parentId: string | null,
  role: 'user' | 'assistant' = 'assistant',
): ChatEntry => ({ id, kind: 'text', role, text, parentId });

describe('ChatThread branches', () => {
  test('buildThreadRows renders the active chain only (siblings out)', () => {
    const entries: Array<ChatEntry> = [
      entry('root', 'root', null, 'user'),
      entry('b', 'b', 'root'),
      entry('c', 'c', 'root'),
    ];
    const { chain } = buildThreadRows(entries, 'c');
    expect(chain.filter((e) => e.kind === 'text').map((e) => e.id)).toEqual(['root', 'c']);
  });

  test('buildThreadRows keeps every branch without a leaf (last-entry fallback)', () => {
    const entries: Array<ChatEntry> = [
      entry('root', 'root', null, 'user'),
      entry('b', 'b', 'root'),
      entry('c', 'c', 'root'),
    ];
    // Unknown/missing leaf falls back to the last entry — chain follows it.
    const { chain, activeLeafId } = buildThreadRows(entries);
    expect(activeLeafId).toBe('c');
    expect(chain.map((e) => e.id)).toEqual(['root', 'c']);
  });

  test('branch switcher removed from default flow: no switcher without variants', async () => {
    renderThread({
      entries: [entry('root', 'root', null, 'user'), entry('c', 'c', 'root')],
      leafId: 'c',
    });
    expect(await screen.findByText('c')).toBeDefined();
    expect(screen.queryByTestId('chat-branch-switcher')).toBeNull();
  });

  test('branch switcher renders only with explicit variants + onSelectLeaf', async () => {
    const entries: Array<ChatEntry> = [
      entry('root', 'root', null, 'user'),
      entry('b', 'b', 'root'),
      entry('c', 'c', 'root'),
    ];
    const { variants, variantIndex, variantCount } = buildThreadRows(entries, 'c');
    const onSelectLeaf = mock((_id: string) => {});
    const user = userEvent.setup();
    renderThread({ entries, leafId: 'c', variants, variantIndex, variantCount, onSelectLeaf });
    expect(await screen.findByText('c')).toBeDefined();
    expect(screen.getByTestId('chat-branch-switcher')).toBeDefined();
    expect(screen.getByTestId('chat-branch-count').textContent).toContain('2 / 2');
    await user.click(screen.getByTestId('chat-branch-prev'));
    expect(onSelectLeaf).toHaveBeenCalledWith('b');
  });

  test('revert control calls onRevert with the message id', async () => {
    const onRevert = mock((_id: string) => {});
    const user = userEvent.setup();
    renderThread({
      messages: [{ id: 'b', role: 'assistant', text: 'answer' }],
      onRevert,
    });
    await user.click(screen.getByTestId('chat-message-revert'));
    expect(onRevert).toHaveBeenCalledWith('b');
  });

  test('leafId scopes entries to the active chain (siblings out)', async () => {
    renderThread({
      entries: [
        entry('root', 'root', null, 'user'),
        entry('b', 'b', 'root'),
        entry('c', 'c', 'root'),
      ],
      leafId: 'b',
    });
    expect(await screen.findByText('b')).toBeDefined();
    expect(screen.queryByText('c')).toBeNull();
  });

  void T0;
});
