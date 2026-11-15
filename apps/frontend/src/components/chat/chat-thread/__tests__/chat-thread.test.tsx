/**
 * ChatThread + ChatInput — kit 0.26.4 adapters (MessageScroller/Message/
 * Bubble/ToolCall/PromptInput).
 *
 * Mapping under test (see chat-thread/* + lib/chat-chain):
 * - ChatThread — kit `MessageScroller` (Provider autoScroll +
 *   defaultScrollPosition="end", Viewport, Content role=log, Items keyed by
 *   message id), height comes from the route layout via `className`
 *   (no viewport-bound height of its own).
 * - Unified chain: `entries` + `leafId` own the order via
 *   `buildThreadRows(entries, leafId).chain`; legacy `messages` stay as a
 *   fallback projection. `messages` are derived via `toChatMessages` useMemo.
 * - Live tools merge via `mergeTextAndLiveTools` (durable text + live sidecar).
 * - Retry lives only in the user-bubble footer (ChatMessageRow onRetry);
 *   the branch switcher is removed from the default flow (variants render
 *   only when explicitly passed with onSelectLeaf).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

const { cleanup, render, screen } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { ChatThread } = await import('..');
const { Toaster, toast } = await import('@web2bizz/ui/widgets');
const { ChatInput } = await import('../../chat-input');
const { I18nProvider } = await import('../../../../i18n');

afterEach(() => {
  cleanup();
  toast.dismiss();
});

function renderThread(props?: Partial<Parameters<typeof ChatThread>[0]>) {
  return render(
    <I18nProvider>
      <ChatThread entries={[]} {...props} />
      <Toaster position="top-right" visibleToasts={4} closeButton />
    </I18nProvider>,
  );
}

describe('ChatThread', () => {
  test('empty: shows the start-conversation placeholder', async () => {
    renderThread();
    expect(await screen.findByText('Start a conversation')).toBeDefined();
  });

  test('loading: shows skeletons with a busy label', () => {
    const { container } = renderThread({ loading: true });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  test('error: shows the message with NO top retry (retry lives only in user footer)', async () => {
    renderThread({ error: 'boom' });
    // Toast-only (kit sonner): the message surfaces in the sonner toast, not inline.
    expect(await screen.findByText('boom')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('error: banner above a live thread preserves messages + streaming, no top Retry without onRetry', async () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'hello' }],
      streamingText: 'partial…',
      sending: true,
      error: 'boom',
    });
    expect(await screen.findByText('boom')).toBeDefined();
    expect(await screen.findByText('hello')).toBeDefined();
    expect(await screen.findByTestId('chat-streaming')).toBeDefined();
    const banner = screen.getByText('boom');
    const threadRow = screen.getByText('hello');
    expect(
      banner.compareDocumentPosition(threadRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="chat-streaming"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('error: empty thread pushes a toast with NO retry button (nothing to preserve)', async () => {
    renderThread({ error: 'boom' });
    // Toast-only (T2, kit sonner): the error pushes a toast (sonner `id`
    // dedupes repeats), the thread falls back to the empty placeholder —
    // no inline ErrorState.
    expect(await screen.findByText('boom')).toBeDefined();
    expect(await screen.findByText('Start a conversation')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('error: onRetry wires the banner Retry button', async () => {
    const onRetry = mock(() => {});
    const user = userEvent.setup();
    renderThread({ error: 'boom', onRetry });
    expect(await screen.findByText('boom')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('error: falsy error renders no banner and keeps the thread clean', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'hello' }],
      error: null,
    });
    expect(await screen.findByText('hello')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    cleanup();
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'hello' }],
      error: '',
    });
    expect(await screen.findByText('hello')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('revert: assistant footer exposes onRevert, user has none of the assistant controls', async () => {
    const onRevert = mock((_id: string) => {});
    const user = userEvent.setup();
    renderThread({
      messages: [
        { id: 'u1', role: 'user', text: 'hello' },
        { id: 'a1', role: 'assistant', text: 'hi there' },
      ],
      onRevert,
    });
    expect(await screen.findByText('hello')).toBeDefined();
    expect(await screen.findByText('hi there')).toBeDefined();
    // Only the assistant row carries the revert control.
    expect(screen.getAllByTestId('chat-message-revert').length).toBe(1);
    await user.click(screen.getByTestId('chat-message-revert'));
    expect(onRevert).toHaveBeenCalledWith('a1');
  });

  test('fork: onFork wires the assistant footer control', async () => {
    const onFork = mock((_id: string) => {});
    const user = userEvent.setup();
    renderThread({
      messages: [{ id: 'a1', role: 'assistant', text: 'hi there' }],
      onFork,
    });
    expect(await screen.findByText('hi there')).toBeDefined();
    await user.click(screen.getByTestId('chat-message-fork'));
    expect(onFork).toHaveBeenCalledWith('a1');
  });

  test('thread: renders kit user/assistant rows', async () => {
    renderThread({
      messages: [
        { id: 'u1', role: 'user', text: 'hello' },
        { id: 'a1', role: 'assistant', text: 'hi there' },
      ],
    });
    expect(await screen.findByText('hello')).toBeDefined();
    expect(await screen.findByText('hi there')).toBeDefined();
    expect(screen.getByTestId('chat-message-user')).toBeDefined();
    expect(screen.getByTestId('chat-message-assistant')).toBeDefined();
    expect(screen.queryByText('You')).toBeNull();
    expect(screen.queryByText('Assistant')).toBeNull();
  });

  test('thread: assistant message renders a ghost (transparent) bubble', async () => {
    const { container } = renderThread({
      messages: [{ id: 'a1', role: 'assistant', text: 'hi there' }],
    });
    expect(await screen.findByText('hi there')).toBeDefined();
    const content = container.querySelector('[data-slot="bubble-content"]') as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.className).not.toContain('bg-muted');
    expect(screen.queryByText('Assistant')).toBeNull();
  });

  test('thread: assistant message exposes like/dislike toggles, user does not', async () => {
    renderThread({
      messages: [
        { id: 'u1', role: 'user', text: 'hello' },
        { id: 'a1', role: 'assistant', text: 'hi there' },
      ],
    });
    expect(await screen.findByText('hi there')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Like' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Dislike' })).toBeDefined();
  });

  test('thread: user message has no like/dislike toggles', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'hello' }],
    });
    expect(await screen.findByText('hello')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Like' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dislike' })).toBeNull();
  });

  test('feedback: like and dislike are mutually exclusive', async () => {
    const user = userEvent.setup();
    renderThread({
      messages: [{ id: 'a1', role: 'assistant', text: 'hi there' }],
    });
    expect(await screen.findByText('hi there')).toBeDefined();
    const like = screen.getByRole('button', { name: 'Like' });
    const dislike = screen.getByRole('button', { name: 'Dislike' });
    expect(like.getAttribute('aria-pressed')).toBe('false');
    await user.click(like);
    expect(like.getAttribute('aria-pressed')).toBe('true');
    expect(dislike.getAttribute('aria-pressed')).toBe('false');
    await user.click(dislike);
    expect(like.getAttribute('aria-pressed')).toBe('false');
    expect(dislike.getAttribute('aria-pressed')).toBe('true');
  });

  test('thread: code fences render as pre/code blocks inside kit Bubble', async () => {
    const { container } = renderThread({
      messages: [{ id: 'c1', role: 'assistant', text: 'see:\n```ts\nconst a = 1;\n```\ndone' }],
    });
    expect(await screen.findByText(/done/)).toBeDefined();
    const pre = container.querySelector('[data-testid="chat-message-assistant"] pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('const a = 1;');
  });

  test('entries: unified chain renders via buildThreadRows(entries, leafId)', async () => {
    renderThread({
      entries: [
        { id: 'root', kind: 'text', role: 'user', text: 'root', parentId: null },
        { id: 'b', kind: 'text', role: 'assistant', text: 'b', parentId: 'root' },
        { id: 'c', kind: 'text', role: 'assistant', text: 'c', parentId: 'root' },
      ],
      leafId: 'c',
    });
    expect(await screen.findByText('root')).toBeDefined();
    expect(await screen.findByText('c')).toBeDefined();
    expect(screen.queryByText('b')).toBeNull();
  });

  test('scroller: kit MessageScroller roles + layout-owned height (no dvh)', () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
    });
    expect(container.querySelector('[role="region"]')).not.toBeNull();
    const log = container.querySelector('[role="log"]') as HTMLElement;
    expect(log).not.toBeNull();
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.getAttribute('aria-relevant')).toBe('additions');
    const item = container.querySelector('[data-message-id="u1"]') as HTMLElement;
    expect(item).not.toBeNull();
    const scroller = container.querySelector('[data-slot="message-scroller"]') as HTMLElement;
    expect(scroller.className).not.toContain('100dvh');
    expect(scroller.className).toContain('h-full');
    expect(scroller.className).toContain('min-h-0');
  });

  test('className: layout geometry passes through without own dvh/absolute', () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      className: 'h-full min-h-[20rem]',
    });
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('h-full');
    const scroller = container.querySelector('[data-slot="message-scroller"]') as HTMLElement;
    expect(scroller.className).not.toContain('100dvh');
  });

  test('streaming: ghost bubble + ShimmerText status below the text', async () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      sending: true,
      streamingText: 'partial…',
    });
    expect(await screen.findByTestId('chat-streaming')).toBeDefined();
    expect(await screen.findByText(/partial/)).toBeDefined();
    expect(await screen.findByText('Streaming…')).toBeDefined();
    const anchor = container.querySelector('[data-scroll-anchor="true"]') as HTMLElement;
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('data-message-id')).toBe('chat-streaming');
    const cursor = container.querySelector('[data-testid="chat-streaming"] .chat-cursor');
    expect(cursor).not.toBeNull();
    expect(cursor?.textContent).toContain('▍');
    const status = container.querySelector('[data-testid="chat-streaming-status"]') as HTMLElement;
    const text = cursor as HTMLElement;
    expect(status).not.toBeNull();
    expect(
      text.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('streaming: a stale streamingText on a closed turn renders no live row', async () => {
    const { container } = renderThread({
      messages: [
        { id: 'u1', role: 'user', text: 'go' },
        { id: 'a1', role: 'assistant', text: 'committed answer' },
      ],
      sending: false,
      streamingText: 'committed answer',
    });
    // Closed turn: live row is gated by `sending && streamingText`, so stale
    // text alone must NOT render a streaming row. The committed answer stays
    // in the thread, no empty stub takes over.
    expect(await screen.findByText('committed answer')).toBeDefined();
    expect(container.querySelector('[data-testid="chat-streaming"]')).toBeNull();
    expect(screen.queryByTestId('chat-streaming')).toBeNull();
    expect(screen.queryByTestId('chat-thinking')).toBeNull();
    expect(screen.queryByText('Start a conversation')).toBeNull();
  });

  test('thinking: a bare ShimmerText status closes the thread, no badge', async () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      sending: true,
    });
    const thinking = await screen.findByTestId('chat-thinking');
    expect(thinking).toBeDefined();
    expect(thinking.getAttribute('aria-busy')).toBe('true');
    expect(await screen.findByText('Thinking…')).toBeDefined();
    expect(screen.queryByText('Assistant')).toBeNull();
    const anchor = container.querySelector('[data-scroll-anchor="true"]') as HTMLElement;
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('data-message-id')).toBe('chat-thinking');
  });

  test('thinking: first request on an empty thread skips the empty state', async () => {
    renderThread({ sending: true });
    expect(await screen.findByTestId('chat-thinking')).toBeDefined();
    expect(screen.queryByText('Start a conversation')).toBeNull();
  });

  test('thinking: placeholder disappears once streamingText arrives', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      sending: true,
      streamingText: 'partial…',
    });
    expect(await screen.findByTestId('chat-streaming')).toBeDefined();
    expect(screen.queryByTestId('chat-thinking')).toBeNull();
  });

  test('timeline: a tool step renders inside the unified tools timeline', async () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      toolTrace: [{ id: 't1', at: 1700000000500, kind: 'tool', label: 'bash', detail: 'called' }],
    });
    const timeline = await screen.findByTestId('chat-tools-timeline');
    expect(timeline).toBeDefined();
    const log = container.querySelector('[role="log"]') as HTMLElement;
    expect(log.contains(timeline)).toBe(true);
    const rows = container.querySelectorAll('[data-testid="chat-tool-call"]');
    expect(rows.length).toBe(1);
    const row = timeline.querySelector('[data-testid="chat-tool-call"]') as HTMLElement;
    expect(row.getAttribute('data-kind')).toBe('tool');
    expect(row.getAttribute('data-status')).toBe('pending');
    expect(row.textContent).toContain('bash');
    expect(row.textContent).not.toContain('Auto');
  });

  test('timeline: messages render before the tools block (single unified block)', async () => {
    const { container } = renderThread({
      messages: [
        { id: 'u1', role: 'user', text: 'first' },
        { id: 'a1', role: 'assistant', text: 'second' },
      ],
      toolTrace: [
        { id: 't1', at: 1700000001000, kind: 'tool', label: 'bash', detail: 'called' },
        { id: 't2', at: 1700000002000, kind: 'reasoning', label: 'reasoning', detail: 'started' },
      ],
    });
    expect(await screen.findByText('first')).toBeDefined();
    expect(await screen.findByText('second')).toBeDefined();
    const timeline = await screen.findByTestId('chat-tools-timeline');
    expect(timeline).toBeDefined();
    const itemU1 = container.querySelector('[data-message-id="u1"]') as HTMLElement;
    const itemTimeline = container.querySelector(
      '[data-message-id="chat-tools-timeline"]',
    ) as HTMLElement;
    expect(itemU1).not.toBeNull();
    expect(itemTimeline).not.toBeNull();
    expect(
      itemU1.compareDocumentPosition(itemTimeline) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('timeline: internal transport kinds hidden, tool/reasoning shown with human labels', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      toolTrace: [
        { id: 't-auth', at: 1700000000000, kind: 'auth' as const, label: 'auth' },
        {
          id: 't-prompt',
          at: 1700000000100,
          kind: 'prompt' as const,
          label: 'POST /api/v1/sessions/ses-1/messages',
          detail: 'auto',
        },
        {
          id: 't-sse',
          at: 1700000000200,
          kind: 'sse' as const,
          label: 'SSE /api/v1/sessions/events connected',
        },
        { id: 't-tool', at: 1700000000300, kind: 'tool' as const, label: 'bash', detail: 'called' },
        {
          id: 't-reason',
          at: 1700000000400,
          kind: 'reasoning' as const,
          label: 'reasoning',
          detail: 'started',
        },
      ],
    });
    expect(screen.queryByText(/POST \/api\/v1\/sessions\/ses-1\/messages/)).toBeNull();
    const rows = await screen.findAllByTestId('chat-tool-call');
    expect(rows.length).toBe(2);
    expect(rows[0]?.getAttribute('data-kind')).toBe('tool');
    expect(rows[0]?.getAttribute('data-status')).toBe('pending');
    expect(rows[0]?.textContent).toContain('bash');
    expect(rows[1]?.getAttribute('data-kind')).toBe('reasoning');
    expect(rows[1]?.textContent).toContain('started');
  });

  test('timeline: only internal transport renders no timeline block', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      toolTrace: [
        {
          id: 't-prompt',
          at: 1700000000100,
          kind: 'prompt' as const,
          label: 'POST /api/v1/sessions/ses-1/messages',
          detail: 'auto',
        },
        {
          id: 't-sse',
          at: 1700000000200,
          kind: 'sse' as const,
          label: 'SSE /api/v1/sessions/events connected',
        },
      ],
    });
    expect(await screen.findByText('go')).toBeDefined();
    expect(screen.queryByTestId('chat-tools-timeline')).toBeNull();
    expect(screen.queryByTestId('chat-tool-live')).toBeNull();
    expect(screen.queryByText(/POST \/api\/v1\/sessions\/ses-1\/messages/)).toBeNull();
  });

  test('timeline: hidden on empty/loading/error-empty threads (only a real thread shows steps)', async () => {
    const trace = [{ id: 't1', at: 1700000000000, kind: 'tool' as const, label: 'bash' }];
    cleanup();
    renderThread({ toolTrace: trace });
    expect(screen.queryByTestId('chat-tools-timeline')).toBeNull();

    cleanup();
    renderThread({ loading: true, toolTrace: trace });
    expect(screen.queryByTestId('chat-tools-timeline')).toBeNull();

    cleanup();
    renderThread({ error: 'boom', toolTrace: trace });
    expect(screen.queryByTestId('chat-tools-timeline')).toBeNull();
  });

  test('thinking: empty reasoning shows the last timeline line instead of a mute shimmer', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      sending: true,
      reasoningText: '',
      toolTrace: [
        { id: 't1', at: 1700000000000, kind: 'tool' as const, label: 'bash', detail: 'called' },
        { id: 't2', at: 1700000001000, kind: 'reasoning' as const, label: 'reasoning', detail: 'started' },
      ],
    });
    expect(await screen.findByTestId('chat-thinking')).toBeDefined();
    expect(await screen.findByTestId('chat-reasoning-fallback')).toBeDefined();
    expect(screen.getByTestId('chat-reasoning-fallback').textContent).toContain('Thinking');
    expect(screen.queryByTestId('chat-reasoning')).toBeNull();
  });

  test('thinking: non-empty reasoning keeps the real preview, no fallback', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      sending: true,
      reasoningText: 'THINKING-TRACE',
      toolTrace: [{ id: 't1', at: 1700000000000, kind: 'tool' as const, label: 'bash', detail: 'called' }],
    });
    expect(await screen.findByTestId('chat-reasoning')).toBeDefined();
    expect(screen.queryByTestId('chat-reasoning-fallback')).toBeNull();
  });

  test('streaming: empty reasoning shows the last timeline line under the ghost bubble', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      sending: true,
      streamingText: 'partial…',
      reasoningText: '',
      toolTrace: [{ id: 't1', at: 1700000000000, kind: 'tool' as const, label: 'bash', detail: 'called' }],
    });
    expect(await screen.findByTestId('chat-streaming')).toBeDefined();
    expect(await screen.findByTestId('chat-reasoning-fallback')).toBeDefined();
    expect(screen.getByTestId('chat-reasoning-fallback').textContent).toContain('bash');
  });

  test('live: activeToolName renders as the running row inside the timeline', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      sending: true,
      activeToolName: 'bash',
      toolTrace: [],
    });
    const live = await screen.findByTestId('chat-tool-live');
    expect(live).toBeDefined();
    expect(live.getAttribute('aria-busy')).toBe('true');
    expect(live.getAttribute('data-status')).toBe('running');
    expect(live.textContent).toContain('bash');
  });

  test('switcher: no switcher without explicit variants (removed from default flow)', async () => {
    renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
    });
    expect(await screen.findByText('go')).toBeDefined();
    expect(screen.queryByTestId('chat-branch-switcher')).toBeNull();
  });
});

describe('ChatInput', () => {
  test('send: Enter submits and clears, button disabled when empty', async () => {
    const onSend = mock((_text: string) => {});
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ChatInput onSend={onSend} sending={false} />
      </I18nProvider>,
    );

    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const sendBtn = screen.getByRole('button', { name: 'Send' });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true);

    await user.type(input, 'hello');
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false);
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  test('send: custom placeholder passes through the kit composer', () => {
    render(
      <I18nProvider>
        <ChatInput onSend={() => {}} placeholder="Ask kit…" />
      </I18nProvider>,
    );
    expect(screen.getByPlaceholderText('Ask kit…')).toBeDefined();
  });

  test('composer: leftSlot lands in the kit action row (Slot.Left)', () => {
    const { container } = render(
      <I18nProvider>
        <ChatInput onSend={() => {}} leftSlot={<span>runner picker</span>} />
      </I18nProvider>,
    );
    const form = container.querySelector('[data-slot="prompt-input"]') as HTMLElement;
    expect(form).not.toBeNull();
    const left = form.querySelector('[data-slot="slot-left"]') as HTMLElement;
    expect(left).not.toBeNull();
    expect(left.textContent).toContain('runner picker');
    const submit = form.querySelector('[data-slot="prompt-input-submit"]') as HTMLElement;
    expect(submit).not.toBeNull();
    expect(
      left.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('sending: input disabled, stop button calls onStop', async () => {
    const onStop = mock(() => {});
    render(
      <I18nProvider>
        <ChatInput onSend={() => {}} onStop={onStop} sending />
      </I18nProvider>,
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    const stopBtn = screen.getByRole('button', { name: 'Stop' });
    const user = userEvent.setup();
    await user.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
