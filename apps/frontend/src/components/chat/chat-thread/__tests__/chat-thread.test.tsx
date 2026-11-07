/**
 * ChatThread + ChatInput — kit 0.26.3 adapters (MessageScroller/Message/
 * Bubble/Marker/ShimmerText/PromptInput).
 *
 * Mapping under test (see chat-thread/*):
 * - ChatThread → kit `MessageScroller` (Provider autoScroll +
 *   defaultScrollPosition="end", Viewport, Content role=log, Items keyed by
 *   message id), height comes from the route layout via `className`
 *   (no viewport-bound height of its own).
 * - ChatMessageRow{role,text} → Message align (user=end/assistant=start) +
 *   Bubble (secondary/ghost transparent) + MessageText,
 *   code-fences stay local <pre><code>.
 * - ChatInput outward props unchanged → kit PromptInput composer
 *   (PromptInputTextarea + PromptInputSubmit that becomes Stop while
 *   streaming).
 *
 * Covers: empty (EmptyState), loading (Skeleton), error (C6 policy: banner
 * above a live thread with retry, full ErrorState only on an empty thread),
 * thread (kit rows + code-fence + no role badges + ghost assistant bubble),
 * scroller roles + height contract (layout-owned, no dvh),
 * streaming (ghost bubble + ShimmerText status below text + cursor), thinking
 * (sending && !streamingText bare ShimmerText line with rotating phrases),
 * timeline (toolTrace/liveToolName inside MessageScrollerContent as an
 * ordinary item without scrollAnchor), send (Enter/button via onSend, clears, disabled while sending, custom
 * placeholder), className passthrough (no own geometry).
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
const { ChatInput } = await import('../../chat-input');
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

describe('ChatThread', () => {
  test('empty: shows the start-conversation placeholder', async () => {
    renderThread();
    expect(await screen.findByText('Start a conversation')).toBeDefined();
  });

  test('loading: shows skeletons with a busy label', () => {
    const { container } = renderThread({ loading: true });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  test('error: shows the message with a retry action', async () => {
    const onRetry = mock(() => {});
    const user = userEvent.setup();
    renderThread({ error: 'boom', onRetry });
    expect(await screen.findByText('boom')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('error: banner above a live thread preserves messages + streaming (C6 policy)', async () => {
    const onRetry = mock(() => {});
    const user = userEvent.setup();
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'hello' }],
      streamingText: 'partial…',
      error: 'boom',
      onRetry,
    });
    // Terminal failure never replaces the thread: banner + thread coexist.
    expect(await screen.findByText('boom')).toBeDefined();
    expect(await screen.findByText('hello')).toBeDefined();
    expect(await screen.findByTestId('chat-streaming')).toBeDefined();
    // The banner sits ABOVE the thread in the DOM.
    const banner = screen.getByText('boom');
    const threadRow = screen.getByText('hello');
    expect(
      banner.compareDocumentPosition(threadRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="chat-streaming"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('error: empty thread renders the full ErrorState (nothing to preserve)', async () => {
    const onRetry = mock(() => {});
    const user = userEvent.setup();
    renderThread({ error: 'boom', onRetry });
    expect(await screen.findByText('boom')).toBeDefined();
    expect(screen.queryByText('Start a conversation')).toBeNull();
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

  test('thread: renders kit user/assistant rows', async () => {
    renderThread({
      messages: [
        { id: 'u1', role: 'user', text: 'hello' },
        { id: 'a1', role: 'assistant', text: 'hi there' },
      ],
    });
    expect(await screen.findByText('hello')).toBeDefined();
    expect(await screen.findByText('hi there')).toBeDefined();
    // Adapter testids preserved through the kit Message wrapper.
    expect(screen.getByTestId('chat-message-user')).toBeDefined();
    expect(screen.getByTestId('chat-message-assistant')).toBeDefined();
    // No role badges anymore.
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

  test('scroller: kit MessageScroller roles + layout-owned height (no dvh)', () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
    });
    // Kit Viewport = role=region, Content = role=log (aria-relevant add).
    expect(container.querySelector('[role="region"]')).not.toBeNull();
    const log = container.querySelector('[role="log"]') as HTMLElement;
    expect(log).not.toBeNull();
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.getAttribute('aria-relevant')).toBe('additions');
    // Items carry the kit scroll metadata.
    const item = container.querySelector('[data-message-id="u1"]') as HTMLElement;
    expect(item).not.toBeNull();
    // Thread fills the layout column: no viewport-bound dvh of its own.
    const scroller = container.querySelector('[data-slot="message-scroller"]') as HTMLElement;
    expect(scroller.className).not.toContain('100dvh');
    expect(scroller.className).toContain('min-h-[20rem]');
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
      streamingText: 'partial…',
    });
    expect(await screen.findByTestId('chat-streaming')).toBeDefined();
    expect(await screen.findByText(/partial/)).toBeDefined();
    expect(await screen.findByText('Streaming…')).toBeDefined();
    // Closes the thread: the live answer is the kit scroll anchor.
    const anchor = container.querySelector('[data-scroll-anchor="true"]') as HTMLElement;
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('data-message-id')).toBe('chat-streaming');
    const cursor = container.querySelector('[data-testid="chat-streaming"] .chat-cursor');
    expect(cursor).not.toBeNull();
    expect(cursor?.textContent).toContain('▍');
    // The shimmer status sits AFTER the streamed text in the DOM.
    const status = container.querySelector('[data-testid="chat-streaming-status"]') as HTMLElement;
    const text = cursor as HTMLElement;
    expect(status).not.toBeNull();
    expect(
      text.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('thinking: a bare ShimmerText status closes the thread, no badge', async () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      sending: true,
    });
    const thinking = await screen.findByTestId('chat-thinking');
    expect(thinking).toBeDefined();
    expect(thinking.getAttribute('aria-busy')).toBe('true');
    // First rotating phrase lives in the kit ShimmerText; no role badge.
    expect(await screen.findByText('Thinking…')).toBeDefined();
    expect(screen.queryByText('Assistant')).toBeNull();
    // The live placeholder closes the thread as the kit scroll anchor.
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

  test('timeline: tool calls render INSIDE the scroller as an ordinary item (no scrollAnchor)', async () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      toolTrace: [{ id: 't1', at: 1700000000000, kind: 'tool', label: 'bash' }],
    });
    const timeline = await screen.findByTestId('chat-tools-timeline');
    expect(timeline).toBeDefined();
    // Inside the kit Content (role=log), not outside the scroller.
    const log = container.querySelector('[role="log"]') as HTMLElement;
    expect(log).not.toBeNull();
    expect(log.contains(timeline)).toBe(true);
    const item = container.querySelector('[data-message-id="chat-tools-timeline"]') as HTMLElement;
    expect(item).not.toBeNull();
    // Ordinary thread item: must NOT steal the auto-follow anchor.
    expect(item.getAttribute('data-scroll-anchor')).not.toBe('true');
  });

  test('timeline: live tool name renders inside the thread with ShimmerText while thinking keeps the anchor', async () => {
    const { container } = renderThread({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      sending: true,
      activeToolName: 'bash',
      toolTrace: [],
    });
    const timeline = await screen.findByTestId('chat-tools-timeline');
    expect(timeline).toBeDefined();
    expect(await screen.findByText('bash')).toBeDefined();
    // Thinking stays the scroll anchor; the timeline item does not.
    const thinkingAnchor = container.querySelector('[data-message-id="chat-thinking"]') as HTMLElement;
    expect(thinkingAnchor.getAttribute('data-scroll-anchor')).toBe('true');
    const timelineItem = container.querySelector(
      '[data-message-id="chat-tools-timeline"]',
    ) as HTMLElement;
    expect(timelineItem.getAttribute('data-scroll-anchor')).not.toBe('true');
    // Timeline sits in the thread before the thinking row.
    expect(
      timelineItem.compareDocumentPosition(thinkingAnchor) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('timeline: hidden on empty/loading/error-empty threads (only a real thread shows it)', async () => {
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
    // The picker sits inside the composer card, before the submit action.
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
