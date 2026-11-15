import { StateSchema } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { CHECKPOINT_MAX_TOTAL_STEPS } from '@rush-code/contracts';

export { CHECKPOINT_MAX_TOTAL_STEPS };

/**
 * Step budget of one turn — a model loop never runs unbounded.
 *
 * Single home of the budget (WEB-9 / A3): the validated default
 * (`DEFAULT_MAX_STEPS`), the runnable config (`buildAgentConfig` with the
 * standalone `recursionLimit` key — `docs/ai-agents/langchain-api-notes.md`
 * §3), and the authoritative counter (`createStepCounterMiddleware` in the
 * `createAgent` `middleware` array — same notes §5). The legacy loop vehicle
 * (`SessionTurnRunnerService.runTurn`) reads the same `resolveMaxSteps`
 * budget; the duplicate out-of-middleware `assertStepBudget` check is gone.
 */
export const DEFAULT_MAX_STEPS: number = 12;

/**
 * Checkpoint segmentation of one turn (WEB-12 / B1) — segment size stays
 * next to the step budget above: a turn is sliced into segments of
 * `CHECKPOINT_SEGMENT_STEPS` model steps, each persisted as one
 * `agent_checkpoints` row, up to the `CHECKPOINT_MAX_TOTAL_STEPS` ceiling
 * (single home in `@rush-code/contracts`, WEB-14 / B3).
 */
export const CHECKPOINT_SEGMENT_STEPS: number = 50;

/**
 * Long-session approval threshold (WEB-16 / C2) — stays next to
 * `CHECKPOINT_SEGMENT_STEPS` above: when a turn crosses this many model
 * steps on a segment boundary the runner parks it on `awaiting_approval`
 * (durable `agent_checkpoints` row, interrupt-like stop, never a 503).
 * Equals one segment by default so the first boundary is the trigger.
 */
export const APPROVAL_AFTER_STEPS: number = 50;

/**
 * Wall-clock budget of one turn (WEB-24 / E3) — single home, next to the
 * segment/approval knobs above. `InProcessTurnService` stamps
 * `deadlineMs = Date.now() + TURN_TIMEOUT_MS` per turn; `runTurn` reads it
 * ONLY on a segment boundary (never mid-segment) and parks the turn on
 * `paused`/`timeout` when expired. Matches the SSE `STREAM_CAP_MS` (5 min)
 * so a live stream never outlives the turn it renders.
 */
export const TURN_TIMEOUT_MS: number = 300_000;

/** Total-steps ceiling lives in `@rush-code/contracts` (single home, WEB-14 / B3). */

/** Typed context of a budget breach — steps/usage done, partial text seen (never invented). */
export type MaxStepsExceededDetails = {
  steps: number;
  usage: { input: number; output: number };
  partialText: string;
};

/**
 * Raised when a turn exceeds the budget (no silent truncation).
 *
 * Segment-internal signal, never an `EXTERNAL_*` outage (never a 503):
 * the messaging layer maps it to the typed `max-steps-exceeded` terminal
 * frames and keeps the already-broadcast partial chain.
 */
export class MaxStepsExceededError extends Error {
  readonly details?: MaxStepsExceededDetails;
  constructor(readonly maxSteps: number, details?: MaxStepsExceededDetails) {
    super(`max-steps-exceeded:${maxSteps}`);
    this.name = 'MaxStepsExceededError';
    if (details !== undefined) this.details = details;
  }
}

/**
 * @deprecated совместимость спек, новый код — resolveMaxSteps.
 */
export function assertStepBudget(stepIndex: number, maxSteps?: number): void {
  const budget: number = resolveMaxSteps(maxSteps);
  if (stepIndex >= budget) throw new MaxStepsExceededError(budget);
}

/**
 * Validates and normalizes a step budget: a positive integer,
 * `DEFAULT_MAX_STEPS` when omitted. Single validation point shared by the
 * middleware factory, the agent config, and the legacy loop vehicle.
 */
export function resolveMaxSteps(value?: number): number {
  const maxSteps: number = value ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error('maxSteps must be a positive integer');
  }
  return maxSteps;
}

/**
 * Runnable config of one agent step (A2 wiring, A4 vehicle).
 *
 * `recursionLimit` is a standalone config key — never inside `configurable`
 * (langchain graph-api docs) — and caps the super-steps of one invocation.
 * `configurable.thread_id` scopes the checkpointer thread (MemorySaver per
 * turn by default, PostgresSaver when `DATABASE_URL` is set).
 */
export type AgentStepConfig = {
  recursionLimit: number;
  configurable: { thread_id: string };
};

/**
 * Builds the agent config of one step: the turn budget as `recursionLimit`
 * (standalone key) plus the turn thread. Passed today as the bound-model
 * `invoke` options (inert metadata for a plain model call) and identical to
 * the config the A4 bridge will pass to `agent.invoke`/`streamEvents`.
 */
export function buildAgentConfig(
  threadId: string,
  maxSteps: number = DEFAULT_MAX_STEPS,
): AgentStepConfig {
  return { recursionLimit: resolveMaxSteps(maxSteps), configurable: { thread_id: threadId } };
}

/**
 * Custom state of the step-counter middleware (middleware/custom docs):
 * the counter lives in agent state so every hook sees the same value.
 */
const StepCounterState = new StateSchema({
  modelCallCount: z.number().default(0),
});

/**
 * Step-counter middleware factory (middleware/custom `createMiddleware` docs:
 * `beforeModel` with `canJumpTo: ['end']` stops the loop past the budget,
 * `afterModel` folds one model call into the counter).
 *
 * The factory shape mirrors the docs' message-limit example; initial state
 * (`modelCallCount: 0`) travels with the A4 `agent.invoke` input. The budget
 * defaults to `DEFAULT_MAX_STEPS` and is validated once via `resolveMaxSteps`.
 */
export function createStepCounterMiddleware(
  maxSteps: number = DEFAULT_MAX_STEPS,
): ReturnType<typeof createMiddleware> {
  const budget: number = resolveMaxSteps(maxSteps);
  return createMiddleware({
    name: 'StepCounterMiddleware',
    stateSchema: StepCounterState,
    beforeModel: {
      canJumpTo: ['end'],
      hook: (state) => {
        if (state.modelCallCount >= budget) return { jumpTo: 'end' as const };
        return;
      },
    },
    afterModel: (state) => ({ modelCallCount: state.modelCallCount + 1 }),
  });
}

/**
 * Tool-loop guard of one turn (WEB-23 / E2).
 *
 * A loop is the SAME pair three times in a row AND the same result hash:
 * the pair is `tool name + normalized args` (`toolCallHash`), the result is
 * `toolResultHash`. Normalization keeps key order out of the verdict (the
 * model reorders JSON keys freely); invalid JSON is compared trimmed as-is.
 * The runner (`runTurn`) stays authoritative for the durable pause
 * (`paused` / `pause_reason='loop'` + the last 3 calls in chat); this
 * middleware only stops the agent-side loop (jump to `end`) so the
 * `createAgent` vehicle cannot spin past the same triplet.
 */
export const LOOP_TRIPLET_LENGTH: number = 3;

/** Hashable fingerprint of one settled tool call (pair hash + result hash). */
export type LoopCallFingerprint = {
  callHash: string;
  resultHash: string;
};

/** One settled tool call with both hashes (chat rendering + persistence). */
export type LoopCallRecord = {
  name: string;
  arguments: string;
  result: string;
  callHash: string;
  resultHash: string;
};

/** Recursively sorts object keys so JSON key order never changes the hash. */
function sortToolValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortToolValue);
  if (value !== null && typeof value === 'object') {
    const entries: Array<[string, unknown]> = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) sorted[key] = sortToolValue(entryValue);
    return sorted;
  }
  return value;
}

/**
 * Normalizes raw tool-call arguments for hashing: valid JSON is re-printed
 * with sorted keys, invalid JSON (the dispatch turns it into an error-result,
 * never a throw) is compared trimmed as-is.
 */
export function normalizeToolArguments(rawArguments: string): string {
  const trimmed: string = rawArguments.trim();
  if (trimmed.length === 0) return '{}';
  try {
    return JSON.stringify(sortToolValue(JSON.parse(trimmed) as unknown)) ?? '{}';
  } catch {
    return trimmed;
  }
}

/** FNV-1a 32-bit hash rendered as 8 lowercase hex chars (pure, no deps). */
export function hashToolString(value: string): string {
  let hash: number = 0x811c9dc5;
  for (let index: number = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Hash of the pair `tool name + normalized args` (one half of the verdict). */
export function toolCallHash(toolName: string, rawArguments: string): string {
  return hashToolString(`${toolName}\n${normalizeToolArguments(rawArguments)}`);
}

/** Hash of the settled tool result (the second half of the verdict). */
export function toolResultHash(result: string): string {
  return hashToolString(result);
}

/** Builds one fingerprinted record from a settled dispatch round entry. */
export function recordLoopCall(toolName: string, rawArguments: string, result: string): LoopCallRecord {
  return {
    name: toolName,
    arguments: rawArguments,
    result,
    callHash: toolCallHash(toolName, rawArguments),
    resultHash: toolResultHash(result),
  };
}

/**
 * Loop verdict over the trailing history: true when the last
 * `LOOP_TRIPLET_LENGTH` records share one pair hash AND one result hash.
 */
export function isLoopTriplet(history: ReadonlyArray<LoopCallFingerprint>): boolean {
  if (history.length < LOOP_TRIPLET_LENGTH) return false;
  const tail: Array<LoopCallFingerprint> = history.slice(-LOOP_TRIPLET_LENGTH);
  const first: LoopCallFingerprint = tail[0] as LoopCallFingerprint;
  return tail.every(
    (entry) => entry.callHash === first.callHash && entry.resultHash === first.resultHash,
  );
}

/** Last triplet of the history (the chat + log payload of the pause). */
export function takeLoopRecent(history: ReadonlyArray<LoopCallRecord>): Array<LoopCallRecord> {
  return history.slice(-LOOP_TRIPLET_LENGTH);
}

/**
 * Chat hint of the pause: the cause plus the last 3 calls (name + args),
 * closed with the no-auto-restart rule — continue with a hint or stop.
 */
export function formatLoopHint(recent: ReadonlyArray<LoopCallRecord>): string {
  const lines: Array<string> = recent.map(
    (entry) => `- ${entry.name} ${normalizeToolArguments(entry.arguments)}`,
  );
  return [
    'Обнаружено зацикливание: один и тот же вызов с тем же результатом 3 раза подряд.',
    ...lines,
    'Продолжите с подсказкой, как выйти из цикла, или остановите ход (авто-рестарта нет).',
  ].join('\n');
}

/** Extracts one tool call (name + raw args text) from an unknown message node. */
function readToolCallNode(node: unknown): { name: string; rawArguments: string } | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record: Record<string, unknown> = node as Record<string, unknown>;
  const name: unknown = record.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const rawArguments: unknown = record.args ?? record.arguments ?? record.input;
  if (typeof rawArguments === 'string') return { name, rawArguments };
  if (rawArguments === undefined || rawArguments === null) return { name, rawArguments: '{}' };
  try {
    return { name, rawArguments: JSON.stringify(rawArguments) ?? '{}' };
  } catch {
    return { name, rawArguments: '{}' };
  }
}

/** Extracts a tool result text from an unknown message node (when carried). */
function readToolResultNode(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (node === null || typeof node !== 'object') return undefined;
  const record: Record<string, unknown> = node as Record<string, unknown>;
  const content: unknown = record.content ?? record.result ?? record.output;
  if (typeof content === 'string') return content;
  return undefined;
}

/**
 * Reconstructs settled tool records from agent messages (defensive: unknown
 * shapes are skipped, never throw). Pairs every assistant `tool_calls` entry
 * with the following tool message by `tool_call_id`; unpaired calls are kept
 * with an empty result so they never fake a triplet.
 */
export function detectLoopInMessages(messages: ReadonlyArray<unknown>): {
  looped: boolean;
  recent: Array<LoopCallRecord>;
} {
  const empty: Array<LoopCallRecord> = [];
  if (messages.length === 0) return { looped: false, recent: empty };
  const pending: Map<string, { name: string; rawArguments: string }> = new Map();
  const history: Array<LoopCallRecord> = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const record: Record<string, unknown> = message as Record<string, unknown>;
    const toolCalls: unknown = record.tool_calls ?? record.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const parsed: { name: string; rawArguments: string } | undefined = readToolCallNode(call);
        if (parsed === undefined) continue;
        const callId: unknown = (call as Record<string, unknown>).id;
        if (typeof callId === 'string' && callId.length > 0) pending.set(callId, parsed);
        else history.push(recordLoopCall(parsed.name, parsed.rawArguments, ''));
      }
      continue;
    }
    const callId: unknown = record.tool_call_id ?? record.toolCallId ?? record.id;
    const result: string | undefined = readToolResultNode(message);
    if (typeof callId === 'string' && callId.length > 0 && result !== undefined) {
      const call: { name: string; rawArguments: string } | undefined = pending.get(callId);
      if (call !== undefined) {
        pending.delete(callId);
        const toolName: unknown = record.name;
        history.push(
          recordLoopCall(
            typeof toolName === 'string' && toolName.length > 0 ? toolName : call.name,
            call.rawArguments,
            result,
          ),
        );
      }
    }
  }
  for (const call of pending.values()) history.push(recordLoopCall(call.name, call.rawArguments, ''));
  const recent: Array<LoopCallRecord> = takeLoopRecent(history);
  return { looped: isLoopTriplet(history), recent };
}

/**
 * Loop-guard middleware factory (agent-side stop, no persistence here).
 *
 * `beforeModel` with `canJumpTo: ['end']` scans the agent messages for the
 * E2 triplet and parks the agent loop; the durable `paused`/`loop` row plus
 * the chat payload stay owned by the runner (`runTurn`), which sees the same
 * triplet over dispatch settlements.
 */
export function createLoopGuardMiddleware(): ReturnType<typeof createMiddleware> {
  return createMiddleware({
    name: 'LoopGuardMiddleware',
    beforeModel: {
      canJumpTo: ['end'],
      hook: (state) => {
        const messages: unknown = (state as { messages?: unknown }).messages;
        if (!Array.isArray(messages)) return;
        if (detectLoopInMessages(messages).looped) return { jumpTo: 'end' as const };
        return;
      },
    },
  });
}
