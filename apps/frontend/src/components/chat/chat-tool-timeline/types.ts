import type { ChatToolEvent } from '../../../hooks/useChatTypes';
import type { Dictionary } from '../../../i18n/dictionaries/types';

export type { ChatToolEvent };

export type ChatToolTimelineProps = {
  /** Chronological tool calls of the session (append-only, see useChat). */
  events: ChatToolEvent[];
  /** Tool name currently reported by the live part frames (null while idle). */
  liveToolName?: string | null;
  /** Live thinking trace (truncated preview, null while idle/text-only). */
  liveReasoningText?: string | null;
};

export type ChatToolsTimelineProps = {
  /** Chronological tool calls of the session (append-only, see useChat). */
  events: ChatToolEvent[];
  /** Tool name currently reported by the live part frames (null while idle). */
  liveToolName?: string | null;
};

/**
 * Kit `ToolCall` status (`@web2bizz/ui` 0.26.4 `widgets`).
 * The kit renders `pending` as queued and `running` with a loading shimmer —
 * Image2 shows them as queued/loading alongside success/warning/error.
 */
export type ToolCallStatus = 'pending' | 'running' | 'success' | 'warning' | 'error';

/**
 * Minimal `ToolCall` card props we drive (source of truth:
 * `node_modules/@web2bizz/ui` `widgets.d.ts` `ToolCallProps`
 * `name`/`args`/`result`/`status`/`summary`).
 */
export type ToolCallCard = {
  name: string;
  args?: string;
  result?: string;
  status: ToolCallStatus;
  summary?: string;
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
 * `detail` → kit `ToolCall` status.
 *
 * Scope-freeze: `ChatToolEvent` carries only `id`/`at`/`kind`/`label`/`detail`
 * (no `args`/`result` — extending `useChat` would break the SSE contract), so
 * the status derives from `detail` alone:
 * - `called`/`started`/empty → `pending` (kit shows queued)
 * - `progress`/`thinking`/free-text snippets → `running` (kit shows loading)
 * - `done` → `success`, `failed`/`*fail*`/`*error*` → `error`
 * - `*warn*`/`*review*` → `warning` (e.g. `deploy_preview` review gate)
 */
export function toToolCallStatus(detail?: string): ToolCallStatus {
  if (typeof detail !== 'string' || detail.length === 0) return 'pending';
  const trimmed = detail.trim();
  if (trimmed === 'called' || trimmed === 'started') return 'pending';
  if (trimmed === 'progress' || trimmed === 'thinking') return 'running';
  if (trimmed === 'done') return 'success';
  if (trimmed === 'failed') return 'error';
  const lower = trimmed.toLowerCase();
  if (lower.includes('fail') || lower.includes('error')) return 'error';
  if (lower.includes('warn') || lower.includes('review')) return 'warning';
  return 'running';
}

/**
 * Event → kit `ToolCall` status (thin wrapper over `toToolCallStatus` for
 * call sites that already hold the event).
 */
export function toToolCallStatusFromEvent(event: ChatToolEvent): ToolCallStatus {
  return toToolCallStatus(event.detail);
}

/**
 * Fixture `args`/`result`/`summary` for the Image2 demo tools.
 *
 * Scope-freeze choice (see `toToolCallProps`): `ChatToolEvent` has no
 * `args`/`result`, and extending `useChat` would break SSE — so the cards
 * derive their ARGUMENTS/RESULT sections from a deterministic
 * label-fixture instead of new transport fields. Unknown labels fall back
 * to the live `detail` snippet (phase keywords stay empty — no invented
 * payloads).
 */
export function getToolCallFixture(label: string): {
  args?: string;
  result?: string;
  summary?: string;
} {
  if (label === 'search_web') {
    return {
      args: '{"query":"ToolCall status","limit":3}',
      result: '3 results\n- ToolCall status mapping\n- ToolCall args/result contract\n- ToolCall queued/loading icons',
      summary: '3 results',
    };
  }
  if (label === 'read_file') {
    return {
      args: 'src/app/page.tsx',
      result: '// src/app/page.tsx\nexport default function Page() {}',
      summary: 'src/app/page.tsx',
    };
  }
  if (label === 'deploy_preview') {
    return {
      args: '{"action":"review"}',
      result: 'review pending — awaiting approval',
      summary: 'review',
    };
  }
  if (label === 'run_tests') {
    return {
      args: '{"suite":"all"}',
      result: 'failed: 1 failing — see RESULT',
      summary: 'failed',
    };
  }
  return {};
}

/**
 * Event → kit `ToolCall` card props.
 *
 * - `name`: tool name as-is, reasoning via `t.chat.reasoningLabel` when `t`
 *   is given (never the raw `reasoning` label alone in the user view).
 * - `status`: `toToolCallStatus(event.detail)`.
 * - `summary`: fixture summary, else the human status word via `t.chat`
 *   (never a raw URL), else the raw `detail`.
 * - `args`/`result`: fixture payloads; unknown labels reuse a free-text
 *   `detail` snippet as `args` (phase keywords stay empty).
 */
export function toToolCallProps(event: ChatToolEvent, t?: Dictionary): ToolCallCard {
  const fixture = getToolCallFixture(event.label);
  const status = toToolCallStatusFromEvent(event);
  const name =
    event.kind === 'reasoning' ? (t ? formatToolEventTitle(event, t) : event.label) : event.label;
  const humanSummary = t ? formatToolEventStatus(event, t) : (event.detail ?? null);
  const summary = fixture.summary ?? humanSummary ?? undefined;
  const detailIsSnippet =
    typeof event.detail === 'string' && event.detail.length > 0 && !isPhaseDetail(event.detail);
  const args = fixture.args ?? (detailIsSnippet ? event.detail : undefined);
  const result = fixture.result;
  return {
    name,
    ...(args ? { args } : {}),
    ...(result ? { result } : {}),
    status,
    ...(summary ? { summary } : {}),
  };
}

/**
 * Live tool name (no trace row yet) → in-flight `ToolCall` card props.
 * Always `running` — the kit shimmers the card while the call streams.
 */
export function toLiveToolCallProps(toolName: string): ToolCallCard {
  return { name: toolName, status: 'running' };
}

/**
 * Live reasoning trace (no trace row yet) → in-flight `ToolCall` card props.
 * Truncated to 500 chars like the thinking/streaming previews.
 */
export function toLiveReasoningCallProps(reasoningText: string, label = 'Thinking'): ToolCallCard {
  const summary = reasoningText.length > 0 ? reasoningText.slice(0, 500) : undefined;
  return {
    name: label,
    status: 'running',
    ...(summary ? { summary } : {}),
  };
}

/**
 * Flat tool-row status (WEB-21/D3, Claude/Cursor-style timeline).
 *
 * Domain vocabulary from `session_messages` (`status`/`detail`), NOT the kit
 * `ToolCall` card vocabulary (`pending`/`success`/`warning`, see
 * `toToolCallStatus` — kept for compat): `running` = in-flight
 * (`called`/`progress`/`started`/`thinking`/free-text snippets),
 * `done` = terminal success, `error` = terminal failure. There is no
 * `warning` row — review-gated steps are still open, hence `running`.
 */
export type ToolRowStatus = 'running' | 'done' | 'error';

/**
 * Domain `status` (primary, `ChatEntryToolStatus`) + `detail` (fallback,
 * `ChatToolEvent`-only shape) → flat row status.
 *
 * Explicit `status` wins: a terminal `done` with a payload snippet stays
 * `done`; an in-flight `called` with a snippet stays `running`. Without an
 * explicit status the `detail` keyword mapping applies (same keywords as
 * `toToolCallStatus`, folded onto the three row states).
 */
export function toToolRowStatus(detail?: string, status?: string): ToolRowStatus {
  if (typeof status === 'string' && status.trim().length > 0) {
    const normalized = status.trim();
    if (
      normalized === 'called' ||
      normalized === 'progress' ||
      normalized === 'started' ||
      normalized === 'thinking'
    ) {
      return 'running';
    }
    if (normalized === 'done' || normalized === 'ended') return 'done';
    if (normalized === 'failed') return 'error';
  }
  if (typeof detail === 'string' && detail.length > 0) {
    const trimmed = detail.trim();
    if (trimmed === 'done') return 'done';
    if (trimmed === 'failed') return 'error';
    const lower = trimmed.toLowerCase();
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
 * Flat row status-dot color (shared by `ChatToolRow` + `ChatToolTimeline`
 * so the two renders cannot drift). Semantic tokens only — no hex, no
 * shadows, no transforms (DESIGN.md §2/§4.1).
 */
export function toolRowDotClass(status: ToolRowStatus): string {
  if (status === 'error') return 'bg-destructive';
  if (status === 'done') return 'bg-muted-foreground/40';
  return 'bg-muted-foreground animate-pulse';
}

/**
 * Raw technical line for `title` tooltips: kind + label + detail, exactly as
 * kind + label + detail, exactly as pushed by `useChat` (POST/SSE included).
 */
export function formatRawToolEventLine(event: ChatToolEvent): string {
  const detail = typeof event.detail === 'string' && event.detail.length > 0 ? ` — ${event.detail}` : '';
  return `${event.kind}: ${event.label}${detail}`;
}
