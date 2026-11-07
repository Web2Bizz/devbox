'use client';

import { Button, ToggleGroup, ToggleGroupItem } from '@web2bizz/ui/components';
import {
  Bubble,
  BubbleContent,
  CopyButton,
  Message,
  MessageContent,
  MessageFooter,
  MessageText,
} from '@web2bizz/ui/widgets';
import { GitFork, History } from 'lucide-react';
import { useState } from 'react';
import type { ChatMessage } from '../../../hooks/useChat';
import { useI18n } from '../../../i18n';

type TextBlock = {
  kind: 'text' | 'code';
  lang: string;
  body: string;
};

/** Split ` ```lang … ``` ` fences — plain paragraphs stay text, code goes <pre><code>. */
function splitBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) {
      blocks.push({ kind: 'text', lang: '', body: text.slice(last, m.index) });
    }
    blocks.push({ kind: 'code', lang: m[1] ?? '', body: m[2] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    blocks.push({ kind: 'text', lang: '', body: text.slice(last) });
  }
  if (blocks.length === 0) blocks.push({ kind: 'text', lang: '', body: text });
  return blocks;
}

/**
 * Footer actions (copy/fork/revert + feedback toggles) share one hover/focus
 * look: transparent background, muted icon/text by default, `foreground` on
 * hover and keyboard focus. Icons use `currentColor`, so `text-*` on the button
 * also recolours the glyph.
 *
 * The kit ships `hover:bg-accent hover:text-accent-foreground` on both
 * `buttonVariants` and `toggleVariants`; `cn` (tailwind-merge) keeps the last
 * class, so this local fragment overrides the kit. `toggleVariants` also lacks
 * `cursor-pointer`, so it is set here explicitly (kit `Button` already has it).
 */
const FOOTER_ACTION_HOVER_CLASS =
  'cursor-pointer text-muted-foreground hover:bg-transparent hover:text-foreground focus-visible:bg-transparent focus-visible:text-foreground';

/**
 * Feedback toggles only need the shared hover/focus fragment plus an explicit
 * transparent idle background; the selected-state look
 * (`data-[state=on]:bg-accent`) is untouched.
 */
const FEEDBACK_TOGGLE_CLASS = `bg-transparent ${FOOTER_ACTION_HOVER_CLASS}`;

/**
 * One chat row on top of kit `widgets` primitives (0.26.3: `Message`,
 * `MessageContent`, `MessageText`, `Bubble`, `BubbleContent`).
 *
 * Adapter only: `ChatMessage{role,text}` → kit `Message align`
 * (user=end, assistant=start) + `MessageContent > Bubble > BubbleContent >
 * MessageText`. No role badges: the user bubble keeps `secondary`; the
 * assistant bubble is kit `ghost` (transparent, no border/padding, full
 * width) — same visual as the mobile assistant bubble. The kit has no
 * markdown, so the fence split stays local: text blocks render through
 * `MessageText` (mention highlighting included), fences as `<pre><code>`
 * (the ghost variant has no padding, the `<pre>` supplies its own).
 * Assistant rows get a `MessageFooter` with like/dislike toggles. Feedback is
 * local UI state only: there is no server-side feedback endpoint, so nothing
 * is sent anywhere and the choice resets on reload.
 * Linear row — no Card wrapper (DESIGN §7: kit tokens only, no hex).
 */
export function ChatMessageRow({
  message,
  onFork,
  onRevert,
}: {
  message: ChatMessage;
  onFork?: (messageId: string) => void;
  onRevert?: (messageId: string) => void;
}) {
  const isUser = message.role === 'user';
  const { t } = useI18n();
  const [feedback, setFeedback] = useState<'up' | 'down' | undefined>();

  return (
    <Message
      align={isUser ? 'end' : 'start'}
      className="py-3"
      data-testid={`chat-message-${message.role}`}
    >
      <MessageContent>
        <Bubble variant={isUser ? 'secondary' : 'ghost'} align={isUser ? 'end' : 'start'}>
          <BubbleContent>
            <div className="grid gap-2">
              {splitBlocks(message.text).map((b, i) =>
                b.kind === 'code' ? (
                  <pre
                    key={i}
                    className="overflow-x-auto rounded-[var(--radius-md)] border p-3 font-mono text-[0.85em] text-muted-foreground text-xs"
                  >
                    {b.lang && (
                      <code className="mb-1 block text-[11px] text-muted-foreground uppercase">
                        {b.lang}
                      </code>
                    )}
                    <code>{b.body}</code>
                  </pre>
                ) : (
                  <MessageText
                    key={i}
                    className="whitespace-pre-wrap text-sm leading-relaxed"
                  >
                    {b.body}
                  </MessageText>
                ),
              )}
            </div>
          </BubbleContent>
        </Bubble>
      </MessageContent>
      <MessageFooter className={isUser ? 'mt-1 justify-end' : 'mt-1'}>
        {!isUser && (
          <ToggleGroup
            type="multiple"
            size="sm"
            spacing={1}
            value={feedback ? [feedback] : []}
            onValueChange={(values) => {
              // type="single" renders radiogroup/aria-checked in this radix
              // version; "multiple" keeps plain toggle buttons (aria-pressed)
              // and we clamp the result to one value ourselves.
              const latest = values[values.length - 1];
              setFeedback(latest === 'up' || latest === 'down' ? latest : undefined);
            }}
          >
            <ToggleGroupItem
              value="up"
              size="sm"
              aria-label={t.chat.like}
              title={t.chat.like}
              className={FEEDBACK_TOGGLE_CLASS}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M7 10v12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="down"
              size="sm"
              aria-label={t.chat.dislike}
              title={t.chat.dislike}
              className={FEEDBACK_TOGGLE_CLASS}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M17 14V2"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        {!isUser && (
          <CopyButton
            content={message.text}
            variant="ghost"
            size="icon"
            className={FOOTER_ACTION_HOVER_CLASS}
            aria-label={t.common.copy}
            title={t.common.copy}
            data-testid="chat-message-copy"
          />
        )}
        {onFork ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`h-7 px-2 text-xs ${FOOTER_ACTION_HOVER_CLASS}`}
            aria-label={t.chat.forkBefore}
            title={t.chat.forkBefore}
            data-testid="chat-message-fork"
            onClick={() => onFork(message.id)}
          >
            <GitFork size={16} aria-hidden="true" />
          </Button>
        ) : null}
        {onRevert ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`h-7 px-2 text-xs ${FOOTER_ACTION_HOVER_CLASS}`}
            aria-label={t.chat.revert}
            title={t.chat.revert}
            data-testid="chat-message-revert"
            onClick={() => onRevert(message.id)}
          >
            <History size={16} aria-hidden="true" />
          </Button>
        ) : null}
      </MessageFooter>
    </Message>
  );
}
