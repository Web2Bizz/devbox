/**
 * ChatWindow + ChatInput — kit 0.26.3 adapters (MessageScroller/Message/
 * Bubble/Marker/ShimmerText/PromptInput).
 *
 * Mapping under test (see chat-*.tsx):
 * - ChatWindow → kit `MessageScroller` (Provider autoScroll +
 *   defaultScrollPosition="end", Viewport, Content role=log, Items keyed by
 *   message id), height cap stays app-owned (`--chat-list-max-h`).
 * - ChatMessageRow{role,text} → Message align (user=end/assistant=start) +
 *   MessageHeader Badge + Bubble (secondary/muted) + MessageText,
 *   code-fences stay local <pre><code>.
 * - ChatInput outward props unchanged → kit PromptInput composer
 *   (PromptInputTextarea + PromptInputSubmit that becomes Stop while
 *   streaming).
 *
 * Covers: empty (EmptyState), loading (Skeleton), error (Alert + retry),
 * thread (kit rows + code-fence), scroller roles + height contract,
 * streaming (Marker + ShimmerText + cursor), send (Enter/button via onSend,
 * clears, disabled while sending, custom placeholder).
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
const { ChatWindow } = await import('../chat-window');
const { ChatInput } = await import('../chat-input');
const { I18nProvider } = await import('../../../i18n');

afterEach(() => {
  cleanup();
});

function renderWindow(props?: Partial<Parameters<typeof ChatWindow>[0]>) {
  return render(
    <I18nProvider>
      <ChatWindow messages={[]} streamingText="" {...props} />
    </I18nProvider>,
  );
}

describe('ChatWindow', () => {
  test('empty: shows the start-conversation placeholder', async () => {
    renderWindow();
    expect(await screen.findByText('Start a conversation')).toBeDefined();
  });

  test('loading: shows skeletons with a busy label', () => {
    const { container } = renderWindow({ loading: true });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  test('error: shows the message with a retry action', async () => {
    const onRetry = mock(() => {});
    const user = userEvent.setup();
    renderWindow({ error: 'boom', onRetry });
    expect(await screen.findByText('boom')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('thread: renders kit user/assistant rows', async () => {
    renderWindow({
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
    // Kit role badges via i18n labels.
    expect(await screen.findByText('You')).toBeDefined();
    expect(await screen.findByText('Assistant')).toBeDefined();
  });

  test('thread: code fences render as pre/code blocks inside kit Bubble', async () => {
    const { container } = renderWindow({
      messages: [{ id: 'c1', role: 'assistant', text: 'see:\n```ts\nconst a = 1;\n```\ndone' }],
    });
    expect(await screen.findByText(/done/)).toBeDefined();
    const pre = container.querySelector('[data-testid="chat-message-assistant"] pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('const a = 1;');
  });

  test('scroller: kit MessageScroller roles + app-owned height cap', () => {
    const { container } = renderWindow({
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
    const scroller = container.querySelector('[data-slot="message-scroller"]') as HTMLElement;
    expect(scroller.className).toContain('--chat-list-max-h');
  });

  test('streaming: kit Marker + ShimmerText status with a cursor', async () => {
    const { container } = renderWindow({
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
