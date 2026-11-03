'use client';

import { Badge } from '@web2bizz/ui/components';
import {
  Bubble,
  BubbleContent,
  Message,
  MessageContent,
  MessageHeader,
  MessageText,
} from '@web2bizz/ui/widgets';
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
 * One chat row on top of kit `widgets` primitives (0.26.3: `Message`,
 * `MessageHeader`, `MessageContent`, `MessageText`, `Bubble`, `BubbleContent`).
 *
 * Adapter only: `ChatMessage{role,text}` → kit `Message align`
 * (user=end, assistant=start) + `MessageHeader` Badge (t.chat.you/assistant)
 * + `MessageContent > Bubble > BubbleContent > MessageText`. The kit has no
 * markdown, so the fence split stays local: text blocks render through
 * `MessageText` (mention highlighting included), fences as `<pre><code>`.
 * Linear row — no Card wrapper (DESIGN §7: kit tokens only, no hex).
 */
export function ChatMessageRow({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const isUser = message.role === 'user';

  return (
    <Message
      align={isUser ? 'end' : 'start'}
      className="py-3"
      data-testid={`chat-message-${message.role}`}
    >
      <MessageHeader>
        <Badge color={isUser ? 'info' : 'success'} variant="soft">
          {isUser ? t.chat.you : t.chat.assistant}
        </Badge>
      </MessageHeader>
      <MessageContent>
        <Bubble variant={isUser ? 'secondary' : 'muted'} align={isUser ? 'end' : 'start'}>
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
    </Message>
  );
}
