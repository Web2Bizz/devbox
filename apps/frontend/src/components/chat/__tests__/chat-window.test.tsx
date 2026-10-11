/**
 * ChatWindow + ChatInput — kit 0.26.0 adapters (Message/Bubble/Marker/InputGroup).
 *
 * Mapping under test (see chat-*.tsx):
 * - ChatMessageRow{role,text} → Message align (user=end/assistant=start) +
 *   MessageHeader Badge (t.chat.you/assistant) + Bubble (secondary/muted),
 *   code-fences stay local <pre><code>.
 * - ChatInput outward props unchanged → InputGroup composer
 *   (InputGroupInput textbox + InputGroupButton Send/Stop).
 * - ChatWindow list → kit rows in app-owned scroller (role=log,
 *   sticky-48px, maxHeight var); streaming row = Message + Marker
 *   shimmer + ▍ cursor; states.tsx branches untouched.
 *
 * Covers: empty (EmptyState), loading (Skeleton), error (Alert + retry),
 * thread (kit rows + separators + code-fence), send (Enter/button via
 * onSend, clears, disabled while sending, custom placeholder),
 * streaming (Marker + cursor), autoscroll (sticks/pauses).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

const { cleanup, render, screen, fireEvent, act } = await import('@testing-library/react');
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

  test('thread: renders kit user/assistant rows with separators', async () => {
    renderWindow({
      messages: [
        { id: 'u1', role: 'user', text: 'hello' },
        { id: 'a1', role: 'assistant', text: 'hi there' },
      ],
    });
    expect(await screen.findByText('hello')).toBeDefined();
    expect(await screen.findByText('hi there')).toBeDefined();
    // Adapter testids preserved through kit Message wrapper.
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

  test('streaming: kit Marker status renders with a cursor', async () => {
    const { container } = renderWindow({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
      streamingText: 'partial…',
    });
    expect(await screen.findByTestId('chat-streaming')).toBeDefined();
    expect(await screen.findByText(/partial/)).toBeDefined();
    expect(await screen.findByText('Streaming…')).toBeDefined();
    const cursor = container.querySelector('[data-testid="chat-streaming"] .chat-cursor');
    expect(cursor).not.toBeNull();
    expect(cursor?.textContent).toContain('▍');
  });

  test('scroller: keeps role=log, aria-live and maxHeight contract', () => {
    const { container } = renderWindow({
      messages: [{ id: 'u1', role: 'user', text: 'go' }],
    });
    const scroller = container.querySelector('[role="log"]') as HTMLElement;
    expect(scroller).not.toBeNull();
    expect(scroller.getAttribute('aria-live')).toBe('polite');
    expect(scroller.style.maxHeight).toContain('--chat-list-max-h');
  });

  test('autoscroll: sticks to bottom, pauses when scrolled up', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      text: `msg ${i}`,
    }));
    const { container, rerender } = render(
      <I18nProvider>
        <ChatWindow messages={msgs} streamingText="" />
      </I18nProvider>,
    );
    const scroller = container.querySelector('[role="log"]') as HTMLElement;
    expect(scroller).not.toBeNull();

    let scrollTop = 0;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    // New message while stuck → pinned to bottom.
    act(() => {
      rerender(
        <I18nProvider>
          <ChatWindow
            messages={[...msgs, { id: 'm5', role: 'user', text: 'msg 5' }]}
            streamingText=""
          />
        </I18nProvider>,
      );
    });
    expect(scrollTop).toBe(1000);

    // Scroll up → pause: next message must NOT yank to bottom.
    scrollTop = 0;
    fireEvent.scroll(scroller);
    act(() => {
      rerender(
        <I18nProvider>
          <ChatWindow
            messages={[...msgs, { id: 'm5', role: 'user', text: 'msg 5' }]}
            streamingText="live…"
          />
        </I18nProvider>,
      );
    });
    expect(scrollTop).toBe(0);
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

    const input = screen.getByRole('textbox') as HTMLInputElement;
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

  test('sending: input disabled, Stop button calls onStop', async () => {
    const onStop = mock(() => {});
    render(
      <I18nProvider>
        <ChatInput onSend={() => {}} onStop={onStop} sending />
      </I18nProvider>,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const stopBtn = screen.getByRole('button', { name: 'Stop' });
    const user = userEvent.setup();
    await user.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
