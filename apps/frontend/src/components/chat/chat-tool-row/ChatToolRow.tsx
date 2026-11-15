'use client';

import { ToolCall } from '@web2bizz/ui/widgets';
import { useI18n } from '../../../i18n';
import type { ChatEntry } from '../../../lib/chat-chain';
import {
  formatRawToolEventLine,
  formatToolEventStatus,
  formatToolEventTitle,
  isToolDetailExpandable,
  toToolRowStatus,
} from './utils';
import type { ChatToolEvent, ToolRowStatus } from './types';
import type { ChatToolRowProps } from './types';

/** Unified chain entry → timeline event (thin render adapter, no new fields). */
function toToolEvent(entry: Extract<ChatEntry, { kind: 'tool' }>): ChatToolEvent {
  return {
    id: entry.id,
    at: entry.at,
    kind: entry.name === 'reasoning' ? 'reasoning' : 'tool',
    label: entry.name,
    ...(entry.detail ?? entry.status ? { detail: entry.detail ?? entry.status } : {}),
  };
}

/**
 * Kit `ToolCall` status from the flat domain row status.
 *
 * Domain vocabulary (`session_messages` via `toToolRowStatus`):
 * `running` → kit `running`, except the initial `called` phase which maps
 * to kit `pending` (queued, no payload yet); `done` → kit `success`;
 * `error` → kit `error`. Kit `warning` is unused — review-gated steps are
 * still open, hence `running`/`pending`. `pending` never comes from
 * `toToolRowStatus` (it only yields `running`/`done`/`error`) — the
 * `called`-phase branch below is the single place that produces it.
 */
function toToolCallStatus(
  rowStatus: ToolRowStatus,
  detail?: string,
): 'pending' | 'running' | 'success' | 'error' {
  if (rowStatus === 'done') return 'success';
  if (rowStatus === 'error') return 'error';
  return detail === 'called' ? 'pending' : 'running';
}

/**
 * One tool/reasoning row of the flat chat chronology — Claude/Cursor-style.
 *
 * The thread is a single chronological list (`message`, `tool`, `tool`,
 * `message`, …), so a tool call is its own flat row in parentId order: a
 * kit `ToolCall` (0.26.5 `widgets`: `name` + `status` + `summary` +
 * `result`, collapsed by default) with the real `detail` payload as
 * `result` (phase keywords render as the `summary` word only — nothing
 * invented, no fixture `args`; the domain carries no separate args).
 *
 * Kit ground truth (0.26.5 `dist/widgets.d.ts` +
 * `docs/agents/components.md`): `ToolCall` status
 * `pending`/`running`/`success`/`error` (kit `warning` unused) via
 * `toToolCallStatus` over the reused `utils` formatters
 * (`toToolRowStatus`/`isToolDetailExpandable`/`formatToolEventStatus`/
 * `formatToolEventTitle` — kept verbatim, never rewritten).
 *
 * Entry-only: the unified `ChatEntry` tool row (durable REST + live SSE
 * share the same type, reload parity before/after) plus the live sidecar
 * `liveToolName` for the in-flight tool with no chain row yet (`running`,
 * `aria-busy`).
 *
 * Statuses are the domain vocabulary (`running`/`done`/`error` from
 * `session_messages` `status`/`detail` via `toToolRowStatus`), failed rows
 * start expanded (`defaultOpen`). Flat content per DESIGN.md §7: no `Card`/
 * `border`/`background` wrapper — only the kit row and kit tokens.
 */
export function ChatToolRow({ entry, liveToolName }: ChatToolRowProps) {
  const { t } = useI18n();
  const resolvedEvent = entry && entry.kind === 'tool' ? toToolEvent(entry) : undefined;
  const domainStatus = entry && entry.kind === 'tool' ? entry.status : undefined;
  const rowStatus: ToolRowStatus = resolvedEvent
    ? toToolRowStatus(resolvedEvent.detail, domainStatus)
    : 'running';
  const expandable = resolvedEvent ? isToolDetailExpandable(resolvedEvent.detail) : false;
  if (!resolvedEvent && !liveToolName) return null;

  if (!resolvedEvent) {
    return (
      <div
        data-testid="chat-tool-live"
        data-kind="tool"
        data-status="running"
        aria-busy="true"
        className="max-w-[80%] py-0.5"
      >
        <ToolCall name={liveToolName ?? ''} status="running" summary={t.chat.toolProgress} />
      </div>
    );
  }

  const kind = resolvedEvent.kind;
  const name = formatToolEventTitle(resolvedEvent, t);
  const statusWord = formatToolEventStatus(resolvedEvent, t);
  const detail = resolvedEvent.detail;

  return (
    <div
      data-testid="chat-tool-row"
      data-kind={kind}
      data-status={rowStatus}
      title={formatRawToolEventLine(resolvedEvent)}
      className="max-w-[80%] py-0.5"
    >
      <ToolCall
        name={name}
        status={toToolCallStatus(rowStatus, detail)}
        {...(statusWord ? { summary: statusWord } : {})}
        {...(expandable && typeof detail === 'string'
          ? {
              result: (
                <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
                  {detail.slice(0, 2000)}
                </pre>
              ),
            }
          : {})}
        defaultOpen={rowStatus === 'error' && expandable}
      />
    </div>
  );
}
