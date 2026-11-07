import type { ChatToolEvent } from '../../../hooks/useChat';
import type { Dictionary } from '../../../i18n/dictionaries/types';

export type ChatToolTimelineProps = {
  /** Chronological tool calls of the session (append-only, see useChat). */
  events: ChatToolEvent[];
  /** Tool name currently reported by the live part frames (null while idle). */
  liveToolName?: string | null;
  /** Live thinking trace (truncated preview, null while idle/text-only). */
  liveReasoningText?: string | null;
};

/**
 * User-visible timeline kinds: agent steps only (`tool` + `reasoning`).
 * Internal transport kinds (`auth/create-session/history/prompt/sse/reload/
 * interrupt`) stay in `useChat` state for debugging but never render as
 * user-facing rows — no raw `POST /api/...` in the default view.
 */
export const VISIBLE_TOOL_EVENT_KINDS: ReadonlyArray<ChatToolEvent['kind']> = [
  'tool',
  'reasoning',
] as const;

export function isVisibleToolEvent(event: ChatToolEvent): boolean {
  return event.kind === 'tool' || event.kind === 'reasoning';
}

export function getVisibleToolEvents(events: Array<ChatToolEvent>): Array<ChatToolEvent> {
  return events.filter(isVisibleToolEvent);
}

/**
 * Human status word for a timeline row via `t.chat` (never a raw URL).
 * Known phase fallbacks map to the dictionary; free-text snippets
 * (tool progress payloads, reasoning deltas) pass through untouched.
 */
export function formatToolEventStatus(
  event: ChatToolEvent,
  t: Dictionary,
): string | null {
  const detail = event.detail;
  if (typeof detail !== 'string' || detail.length === 0) {
    if (event.kind === 'tool') return t.chat.toolCalled;
    if (event.kind === 'reasoning') return t.chat.reasoningThinking;
    return null;
  }
  if (event.kind === 'tool') {
    if (detail === 'called') return t.chat.toolCalled;
    if (detail === 'progress') return t.chat.toolProgress;
    if (detail === 'done') return t.chat.toolDone;
    if (detail === 'failed') return t.chat.toolFailed;
    return detail;
  }
  if (detail === 'started') return t.chat.reasoningStarted;
  if (detail === 'thinking') return t.chat.reasoningThinking;
  if (detail === 'done') return t.chat.reasoningDone;
  return detail;
}

/**
 * Human main label of a visible row: tool name as-is, reasoning as
 * `t.chat.reasoningLabel` (never the raw `reasoning` label alone).
 */
export function formatToolEventTitle(event: ChatToolEvent, t: Dictionary): string {
  if (event.kind === 'reasoning') return t.chat.reasoningLabel;
  return event.label;
}

/**
 * Single-line human fallback for the thinking/streaming rows when
 * `reasoningText` is empty: last visible agent step, never a raw
 * transport line. Returns null when no visible step exists.
 */
export function formatVisibleFallback(
  events: Array<ChatToolEvent>,
  t: Dictionary,
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || !isVisibleToolEvent(event)) continue;
    const title = formatToolEventTitle(event, t);
    const status = formatToolEventStatus(event, t);
    const text = status ? `${title} — ${status}` : title;
    return text.slice(0, 500);
  }
  return null;
}

/**
 * Raw technical line for the debug `<details>` block and `title` tooltips:
 * kind + label + detail, exactly as pushed by `useChat` (POST/SSE included).
 */
export function formatRawToolEventLine(event: ChatToolEvent): string {
  const detail = typeof event.detail === 'string' && event.detail.length > 0 ? ` — ${event.detail}` : '';
  return `${event.kind}: ${event.label}${detail}`;
}
