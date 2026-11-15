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

const entry = (
  id: string,
  text: string,
  parentId: string | null,
  role: 'user' | 'assistant' = 'assistant',
): ChatEntry => ({ id, kind: 'text', role, text, parentId });

/**
 * Цепочка в треде (Фаза unified): chain-index через parentId.
 * - message-message сравниваются по chain-index, а не по at
 * - leafId фильтрует siblings out; unknown leaf → fallback на последнюю запись
 * - switcher только с явными variants + onSelectLeaf; revert через onRevert
 */
describe('ChatThread chain hardening', () => {
  test('message-message идут по chain-index, а не по at (ссылки побеждают часы)', () => {
    const entries: Array<ChatEntry> = [
      entry('root', 'root', null, 'user'),
      entry('b', 'b', 'root'),
      entry('c', 'c', 'b'),
    ];
    const { chain } = buildThreadRows(entries, 'c');
    expect(chain.map((e) => e.id)).toEqual(['root', 'b', 'c']);
  });

  test('1→N без fallback на полный тред: без leaf — последний как leaf', () => {
    const entries: Array<ChatEntry> = [
      entry('root', 'root', null, 'user'),
      entry('b', 'b', 'root'),
      entry('c', 'c', 'root'),
      entry('d', 'd', 'b'),
    ];
    const { chain, activeLeafId } = buildThreadRows(entries);
    expect(activeLeafId).toBe('d');
    expect(chain.map((e) => e.id)).toEqual(['root', 'b', 'd']);
  });

  test('leafId фильтрует siblings out; unknown leaf → fallback на последнюю', () => {
    const entries: Array<ChatEntry> = [
      entry('root', 'root', null, 'user'),
      entry('b', 'b', 'root'),
      entry('c', 'c', 'root'),
    ];
    expect(buildThreadRows(entries, 'c').chain.map((e) => e.id)).toEqual(['root', 'c']);
    // Неизвестный leaf не должен давать пусто — fallback на последнюю запись.
    expect(buildThreadRows(entries, 'ghost').activeLeafId).toBe('c');
    expect(buildThreadRows(entries, 'ghost').chain.map((e) => e.id)).toEqual(['root', 'c']);
    expect(buildThreadRows(entries, null).chain.length).toBe(2);
  });

  test('message-tool по-прежнему в одном timeline-блоке после сообщений', async () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      toolTrace: [
        { id: 't1', at: 1700000000000, kind: 'tool', label: 'bash', detail: 'called' },
        { id: 't2', at: 1700000000000, kind: 'tool', label: 'edit', detail: 'called' },
      ],
    });
    expect(await screen.findByText('go')).toBeDefined();
    const timeline = await screen.findByTestId('chat-tools-timeline');
    expect(timeline).toBeDefined();
    expect(container.querySelectorAll('[data-testid="chat-tool-call"]').length).toBe(2);
  });

  test('entries tool rows render the timeline (chain owns tools, not only toolTrace)', async () => {
    const toolCalled = {
      id: 't1',
      kind: 'tool' as const,
      name: 'bash',
      detail: 'called',
      status: 'called' as const,
      parentId: 'u1',
      at: 1700000000500,
    };
    const toolDone = {
      id: 't2',
      kind: 'tool' as const,
      name: 'bash',
      detail: 'done',
      status: 'done' as const,
      parentId: 'u1',
      at: 1700000000600,
    };
    const { container } = renderThread({
      entries: [{ id: 'u1', kind: 'text' as const, role: 'user' as const, text: 'go', parentId: null }, toolCalled, toolDone],
      leafId: 't2',
      toolTrace: [],
    });
    expect(await screen.findByText('go')).toBeDefined();
    const timeline = await screen.findByTestId('chat-tools-timeline');
    expect(timeline).toBeDefined();
    const rows = container.querySelectorAll('[data-testid="chat-tool-call"]');
    expect(rows.length).toBe(2);
    expect(rows[0]?.getAttribute('data-status')).toBe('pending');
    expect(rows[1]?.getAttribute('data-status')).toBe('success');
    expect(timeline.textContent).toContain('bash');
  });

  test('switcher removed from default flow: no branch-switcher without variants', async () => {
    renderThread({
      entries: [entry('root', 'root', null, 'user'), entry('c', 'c', 'root')],
      leafId: 'c',
    });
    expect(await screen.findByText('c')).toBeDefined();
    expect(screen.queryByTestId('chat-branch-switcher')).toBeNull();
  });

  test('контролы revert: кнопка зовёт onRevert(messageId)', async () => {
    const onRevert = mock((_id: string) => {});
    const user = userEvent.setup();
    renderThread({
      messages: [{ id: 'b', role: 'assistant', text: 'answer' }],
      onRevert,
    });
    await user.click(screen.getByTestId('chat-message-revert'));
    expect(onRevert).toHaveBeenCalledWith('b');
  });

  test('hostile: пустые entries не падают, свитчер скрыт', () => {
    const { chain } = buildThreadRows([], 'ghost');
    expect(chain).toEqual([]);
    const { container } = renderThread({ messages: [] });
    expect(container.querySelector('[data-testid="chat-branch-switcher"]')).toBeNull();
  });
});
