import type { ToolCall, ToolSettlement } from '../../../tool-runtime/tool-runtime.types';

/**
 * Pure step-loop primitives (donor `packages/ai/src/loop.ts` semantics).
 *
 * No DI, no transport: the runner feeds `LoopStep` values in and dispatches
 * the pending calls. These functions decide what is terminal and how the
 * next request/messages look — everything is unit-testable without a model.
 */

/** Token usage of one model step (fields the loop folds; unknown stay absent). */
export type TokenUsage = {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** One model step: its text, calls and finish reason. */
export type LoopStep = {
  text: string;
  calls: Array<ToolCall>;
  /** Provider finish reason ('tool-calls' | 'stop' | 'length' | …). */
  finishReason: string | null;
  usage?: TokenUsage;
  /** Model-router audit meta of this step (attempts/fallback), when reported. */
  meta?: StepMeta;
};

/** One model attempt the router made for a step (fixed literals, no secrets). */
export type StepAttempt = {
  provider: string;
  model: string;
  attempt: number;
  outcome: string;
  reason: string;
  latencyMs: number;
};

/** Audit meta of one model step (additive; absent transport meta stays absent). */
export type StepMeta = {
  provider?: string;
  model?: string;
  attempts?: Array<StepAttempt>;
  fallback?: { attempts: number; switchedFrom?: string; reason?: string };
};

/** Next-request knobs derived from the step index. */
export type StepRequest = {
  /** Forced tool choice only on the FIRST step (the model must act, not chat). */
  toolChoice: 'required' | 'auto';
};

/** Message appended to the conversation after one step round-trip. */
export type LoopMessage = {
  /** `system`/`user` seed the conversation, `assistant`/`tool` continue it. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallID?: string;
  toolName?: string;
  /**
   * Tool calls of an assistant echo (`stepMessages`), kept so the next model
   * request carries the assistant tool_calls its tool rows answer to — a tool
   * message without a matching call is invalid on the OpenAI wire. Absent on
   * seed/user/system rows.
   */
  toolCalls?: Array<ToolCall>;
};

/** Settled state of one turn as reconstructed from published frames. */
export type CollectedTurn = {
  steps: number;
  toolResults: Array<ToolSettlement>;
  finishReason: string;
  text: string;
};

/** Stream frame shape the collector folds (envelope subset only). */
export type TurnFrame = {
  type: string;
  data: Record<string, unknown>;
};

/** The model stopped mid-stream: a turn without a finish frame is not a turn. */
export class IncompleteStreamError extends Error {
  constructor() {
    super('incomplete-stream');
    this.name = 'IncompleteStreamError';
  }
}

/**
 * Calls the runner must dispatch: an empty list means the step is terminal.
 * `answerTool` is the donor's terminal answer call; `length` means the model
 * hit the token cap — replaying calls then would be a lie, so it is terminal.
 */
export function pendingCalls(step: LoopStep): Array<ToolCall> {
  if (step.finishReason === 'length') return [];
  return step.calls.filter((call) => call.name !== 'answerTool');
}

/** Forced tool choice only on the first step; later steps run `auto`. */
export function nextRequest(_step: LoopStep, stepIndex: number): StepRequest {
  return { toolChoice: stepIndex === 0 ? 'required' : 'auto' };
}

/**
 * Assistant echo + one tool row per settlement (call order preserved).
 *
 * The assistant row carries the step's own `toolCalls` so the OpenAI wire sees
 * a call for every `tool_call_id` row that follows; without it the next
 * request is invalid (tool message without a matching assistant call).
 */
export function stepMessages(
  step: LoopStep,
  settlements: Array<ToolSettlement>,
): Array<LoopMessage> {
  const messages: Array<LoopMessage> = [
    {
      role: 'assistant',
      content: step.text,
      ...(step.calls.length > 0 ? { toolCalls: step.calls } : {}),
    },
    ...settlements.map((settlement) => ({
      role: 'tool' as const,
      content: settlement.result,
      toolCallID: settlement.callID,
      toolName: settlement.name,
    })),
  ];
  return messages;
}

/** Fold one usage row into the running total (absent counters stay absent). */
export function addUsage(total: TokenUsage, usage?: TokenUsage): TokenUsage {
  if (!usage) return total;
  const sum: (
    left: number | undefined,
    right: number | undefined,
  ) => number | undefined = (left: number | undefined, right: number | undefined) =>
    right === undefined ? left : (left ?? 0) + right;
  return {
    input: (total.input ?? 0) + usage.input,
    output: (total.output ?? 0) + usage.output,
    ...(sum(total.reasoning, usage.reasoning) !== undefined
      ? { reasoning: sum(total.reasoning, usage.reasoning) }
      : {}),
    ...(sum(total.cacheRead, usage.cacheRead) !== undefined
      ? { cacheRead: sum(total.cacheRead, usage.cacheRead) }
      : {}),
    ...(sum(total.cacheWrite, usage.cacheWrite) !== undefined
      ? { cacheWrite: sum(total.cacheWrite, usage.cacheWrite) }
      : {}),
  };
}

/**
 * Fold published frames (step-start → step-finish → tool-result … → finish)
 * into one turn. A stream that ends mid-turn (steps seen, no finish) is an
 * incomplete stream — never a silent partial turn.
 */
export function collect(frames: Array<TurnFrame>): CollectedTurn {
  let steps: number = 0;
  let sawFinish: boolean = false;
  let finishReason: string = '';
  let text: string = '';
  const toolResults: Array<ToolSettlement> = [];
  for (const frame of frames) {
    if (frame.type === 'step-start') {
      steps += 1;
      continue;
    }
    if (frame.type === 'finish') {
      sawFinish = true;
      const reason: unknown = frame.data.finishReason;
      finishReason = typeof reason === 'string' && reason.length > 0 ? reason : 'stop';
      const body: unknown = frame.data.text;
      if (typeof body === 'string') text = body;
      continue;
    }
    if (frame.type === 'tool-result') {
      const callID: unknown = frame.data.callID;
      const name: unknown = frame.data.name;
      const result: unknown = frame.data.result;
      if (typeof callID === 'string' && typeof name === 'string' && typeof result === 'string') {
        toolResults.push({ callID, name, result });
      }
    }
  }
  if (!sawFinish) throw new IncompleteStreamError();
  return { steps, toolResults, finishReason, text };
}
