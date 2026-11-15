import type { ChatToolEvent } from '../../../hooks/useChatTypes';
import type { Dictionary } from '../../../i18n/dictionaries/types';
import type { ToolRowStatus } from './types';

/**
 * User-visible timeline kinds: mode steps only (`tool` + `reasoning`).
 * Internal transport kinds (`auth/create-session/history/prompt/sse/reload/
 * interrupt`) stay in `useChat` state for debugging but never render as
 * user-facing rows — no raw `POST /api/...` in the default view.
 */
export const VISIBLE_TOOL_EVENT_KINDS: ReadonlyArray<ChatToolEvent['kind']> = [
  'tool',
  'reasoning',
];

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
export function formatToolEventStatus(event: ChatToolEvent, dictionary: Dictionary): string | null {
  const detail: string | undefined = event.detail;
  if (typeof detail !== 'string' || detail.length === 0) {
    if (event.kind === 'tool') return dictionary.chat.toolCalled;
    if (event.kind === 'reasoning') return dictionary.chat.reasoningThinking;
    return null;
  }
  if (event.kind === 'tool') {
    switch (detail) {
      case 'called':
        return dictionary.chat.toolCalled;
      case 'progress':
        return dictionary.chat.toolProgress;
      case 'done':
        return dictionary.chat.toolDone;
      case 'failed':
        return dictionary.chat.toolFailed;
      default:
        return detail;
    }
  }
  switch (detail) {
    case 'started':
      return dictionary.chat.reasoningStarted;
    case 'thinking':
      return dictionary.chat.reasoningThinking;
    case 'done':
      return dictionary.chat.reasoningDone;
    default:
      return detail;
  }
}

/**
 * Human main label of a visible row: tool name as-is, reasoning as
 * `t.chat.reasoningLabel` (never the raw `reasoning` label alone).
 */
export function formatToolEventTitle(event: ChatToolEvent, dictionary: Dictionary): string {
  if (event.kind === 'reasoning') return dictionary.chat.reasoningLabel;
  return event.label;
}

/**
 * Single-line human fallback for the thinking/streaming rows when
 * `reasoningText` is empty: last visible mode step, never a raw
 * transport line. Returns null when no visible step exists.
 */
export function formatVisibleFallback(
  events: Array<ChatToolEvent>,
  dictionary: Dictionary,
): string | null {
  for (let index: number = events.length - 1; index >= 0; index -= 1) {
    const event: ChatToolEvent = events[index];
    if (!event || !isVisibleToolEvent(event)) continue;
    const title: string = formatToolEventTitle(event, dictionary);
    const status: string | null = formatToolEventStatus(event, dictionary);
    const text: string = status ? `${title} — ${status}` : title;
    return text.slice(0, 500);
  }
  return null;
}

const PHASE_DETAILS: ReadonlySet<string> = new Set([
  'called',
  'progress',
  'done',
  'failed',
  'started',
  'thinking',
]);

function isPhaseDetail(detail: string): boolean {
  return PHASE_DETAILS.has(detail);
}

/**
 * Domain `status` (primary, `ChatEntryToolStatus`) + `detail` (fallback,
 * `ChatToolEvent`-only shape) → flat row status.
 *
 * Explicit `status` wins: a terminal `done` with a payload snippet stays
 * `done`; an in-flight `called` with a snippet stays `running`. Without an
 * explicit status the `detail` keyword mapping applies.
 */
export function toToolRowStatus(detail?: string, status?: string): ToolRowStatus {
  if (typeof status === 'string' && status.trim().length > 0) {
    const normalized: string = status.trim();
    switch (normalized) {
      case 'called':
      case 'progress':
      case 'started':
      case 'thinking':
        return 'running';
      case 'done':
      case 'ended':
        return 'done';
      case 'failed':
        return 'error';
      default:
        break;
    }
  }
  if (typeof detail === 'string' && detail.length > 0) {
    const trimmed: string = detail.trim();
    if (trimmed === 'done') return 'done';
    if (trimmed === 'failed') return 'error';
    const lower: string = trimmed.toLowerCase();
    if (lower.includes('fail') || lower.includes('error')) return 'error';
    return 'running';
  }
  return 'running';
}

/**
 * Whether a `detail` string is user-expandable (a real payload snippet).
 * Phase keywords (`called`/`progress`/`done`/…) render as the status word
 * only — expanding them would show an invented-looking echo.
 */
export function isToolDetailExpandable(detail?: string): boolean {
  return typeof detail === 'string' && detail.length > 0 && !isPhaseDetail(detail);
}

/**
 * Flat row status-dot color (used by `ChatToolRow`). Semantic tokens only —
 * no hex, no shadows, no transforms (DESIGN.md §2/§4.1).
 */
export function toolRowDotClass(status: ToolRowStatus): string {
  if (status === 'error') return 'bg-destructive';
  if (status === 'done') return 'bg-muted-foreground/40';
  return 'bg-muted-foreground animate-pulse';
}

/**
 * Raw technical line for `title` tooltips: kind + label + detail, exactly as
 * pushed by `useChat` (POST/SSE included).
 */
export function formatRawToolEventLine(event: ChatToolEvent): string {
  const detail: string =
    typeof event.detail === 'string' && event.detail.length > 0 ? ` — ${event.detail}` : '';
  return `${event.kind}: ${event.label}${detail}`;
}
