import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';
import type { CryptoService } from '@common/crypto/crypto.service';
import type { VaultService } from '@common/vault/vault.service';
import { AppLogger } from '@common/logger';
import { createModelClient } from '../../../agents/model-client';
import { runModelChain, type ModelRunMeta } from '../../../agents/model-fallback';
import { loadProviderKey, type ModelChainEntry } from '../../../agents/model-provider';
import type { OpencodeModelFetch } from '../../../opencode/opencode-model-fetch';
import {
  ToolDispatchService,
  type ToolEffectsStore,
} from '../../../tool-dispatch/tool-dispatch.service';
import type { ToolCall, ToolContext, ToolMode, ToolSettlement } from '../../../tool-runtime/tool-runtime.types';
import {
  addUsage,
  type LoopMessage,
  type LoopStep,
  nextRequest,
  pendingCalls,
  stepMessages,
  type StepAttempt,
  type StepMeta,
  type StepRequest,
  type TokenUsage,
  type TurnFrame,
} from './loop';
import {
  APPROVAL_AFTER_STEPS,
  buildAgentConfig,
  CHECKPOINT_MAX_TOTAL_STEPS,
  CHECKPOINT_SEGMENT_STEPS,
  createLoopGuardMiddleware,
  createStepCounterMiddleware,
  formatLoopHint,
  isLoopTriplet,
  MaxStepsExceededError,
  recordLoopCall,
  resolveMaxSteps,
  takeLoopRecent,
  type AgentStepConfig,
  type LoopCallRecord,
} from './max-steps';
import type { SessionCheckpointStatus } from '@rush-code/contracts';
import { SessionHistoryRepository } from '../../session-history.repository';
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from './retry';

/** Step budget and counter live in `./max-steps` (single home of the budget). */

/**
 * Checkpointer backing the turn agent: in-memory default, Postgres when the
 * process is configured with `DATABASE_URL` (never logged — it carries
 * credentials; only the kind is ever logged).
 */
export type TurnCheckpointer = MemorySaver | PostgresSaver;

let cachedTurnCheckpointer: TurnCheckpointer | undefined;

/** Module logger of the agent wiring (no secrets, no stacks in normal path). */
const agentLogger: AppLogger = new AppLogger('SessionTurnRunnerService');

/** Checkpointer kind for logs (never the connection string). */
function checkpointerKind(checkpointer: TurnCheckpointer): string {
  return checkpointer instanceof PostgresSaver ? 'postgres' : 'memory';
}

/**
 * Resolves the turn checkpointer (cached per process):
 * `PostgresSaver.fromConnString(DATABASE_URL)` when configured, otherwise a
 * fresh `MemorySaver`. Memory is the documented default (dev without a DB);
 * Postgres is opt-in via the standard env the db layer already validates —
 * never a silent fallback, never a new env name.
 */
export function resolveTurnCheckpointer(): TurnCheckpointer {
  if (cachedTurnCheckpointer !== undefined) return cachedTurnCheckpointer;
  const databaseUrl: string = (process.env.DATABASE_URL ?? '').trim();
  cachedTurnCheckpointer =
    databaseUrl.length > 0 ? PostgresSaver.fromConnString(databaseUrl) : new MemorySaver();
  return cachedTurnCheckpointer;
}

/**
 * Best-effort one-time setup of the cached checkpointer (Postgres tables via
 * `setup()`; `MemorySaver` needs none). Never throws and never blocks a step:
 * a failed setup warns once and the cache falls back to memory (the next turn
 * picks it up; the current turn keeps its already-assembled instance).
 */
async function ensureTurnCheckpointerReady(checkpointer: TurnCheckpointer): Promise<void> {
  const setup: unknown = (checkpointer as { setup?: unknown }).setup;
  if (typeof setup !== 'function') return;
  try {
    await (setup as () => Promise<unknown>).call(checkpointer);
  } catch {
    agentLogger.warn('[runner] checkpointer setup failed, falling back to memory');
    cachedTurnCheckpointer = new MemorySaver();
  }
}

/** Input of the turn-agent factory (one agent per resolved model client). */
export type CreateTurnAgentInput = {
  /** Resolved chain client of this attempt (the agent's model node). */
  model: ChatOpenAI;
  /** Mode-filtered LangChain tools of the turn (executor-time bindings). */
  tools: ReadonlyArray<DynamicStructuredTool>;
  /** Domain system prompt of the turn (omitted when empty, like the seed). */
  systemPrompt: string;
  /** Step budget of the turn (outer `runTurn` stays authoritative). */
  maxSteps?: number;
  /** Checkpointer override (tests); production resolves it per process. */
  checkpointer?: TurnCheckpointer;
};

/** A `createAgent` turn instance (the A4 bridge invokes/streams it). */
export type TurnAgent = ReturnType<typeof createAgent>;

/**
 * Assembles the turn agent around one resolved model client
 * (`createAgent` with model/tools/systemPrompt/step-counter
 * middleware/checkpointer).
 *
 * A4 owns the `agent.invoke`/`streamEvents` flip: these executor-time tool
 * bindings close over executor-time context (no per-turn runId/effects), so
 * the bridge must rebind tools per turn before invoking.
 */
export function createTurnAgent(input: CreateTurnAgentInput): TurnAgent {
  const maxSteps: number = resolveMaxSteps(input.maxSteps);
  const checkpointer: TurnCheckpointer = input.checkpointer ?? resolveTurnCheckpointer();
  void ensureTurnCheckpointerReady(checkpointer);
  const systemPrompt: string = input.systemPrompt.trim();
  const agent: TurnAgent = createAgent({
    model: input.model,
    tools: [...input.tools],
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    middleware: [createStepCounterMiddleware(maxSteps), createLoopGuardMiddleware()],
    checkpointer,
  });
  agentLogger.debug(
    `[runner] turn agent wired tools=${input.tools.length} maxSteps=${maxSteps} checkpointer=${checkpointerKind(checkpointer)}`,
  );
  return agent;
}

/**
 * LangChain `streamEvents` v3 event-stream shape the A4 bridge consumes
 * (`docs/ai-agents/langchain-api-notes.md` §2: `stream.messages` /
 * `message.text` / `message.toolCalls` / `stream.toolCalls` /
 * `stream.output`). Structural on purpose: the pin-local `streamEvents`
 * return type is cast once at the call site, everything below relies only on
 * the documented async-iterable shape.
 */
export type AgentStreamTextMessage = {
  /** Live text deltas of one streamed message. */
  text: AsyncIterable<string>;
  /** Tool-call argument chunks of the message (observed, not authoritative). */
  toolCalls?: AsyncIterable<unknown>;
};

/** One announced tool call of `stream.toolCalls` (result or error settles). */
export type AgentStreamToolCall = {
  id?: unknown;
  name?: unknown;
  input?: unknown;
  /** Settles with the tool result (absent when the call failed). */
  output?: unknown;
  /** Settles with the failure (when `output` is absent). */
  error?: unknown;
};

/** The v3 stream behind `agent.streamEvents(input, { version: 'v3' })`. */
export type AgentStreamEventsV3 = {
  /** Streamed messages (text deltas + per-message tool-call chunks). */
  messages: AsyncIterable<AgentStreamTextMessage>;
  /** Announced tool calls with their settled result/error. */
  toolCalls: AsyncIterable<AgentStreamToolCall>;
  /** Final agent state (usage is read defensively, never required). */
  output: Promise<unknown>;
};

/**
 * Input of the A4 streaming bridge (one agent turn → `TurnFrame`s).
 */
export type StreamAgentTurnInput = {
  /**
   * Turn agent built per turn around rebound tools: the LC tool `func`s close
   * over executor-time context (no per-turn runId/effects), so the caller
   * rebinds tools per turn before invoking — the bridge never reuses a stale
   * agent across turns.
   */
  agent: TurnAgent;
  /** Domain system prompt of the turn (prepended once, like the invoke vehicle). */
  systemPrompt: string;
  /** Turn messages (prior turns travel via the agent thread, `thread_id`). */
  messages: Array<LoopMessage>;
  /**
   * Agent config with `configurable.thread_id` (the checkpointer thread,
   * `buildAgentConfig`) and the standalone `recursionLimit` step budget —
   * forwarded with `version: 'v3'` (event-streaming docs §2). The step budget
   * itself is enforced inside the agent by `createStepCounterMiddleware`.
   */
  config: AgentStepConfig;
  /** Frame sink (the harness maps these onto SSE frames). */
  publish: PublishFrame;
  /** Downstream abort (forwarded to `streamEvents` when present). */
  signal?: AbortSignal;
  /** Correlation id of the attempt audit lines. */
  correlationId?: string;
};

/** Raw tool input → the RAW JSON text a `tool-call` frame carries. */
function toolInputText(callInput: unknown): string {
  if (typeof callInput === 'string') return callInput;
  if (callInput === undefined || callInput === null) return '{}';
  try {
    return JSON.stringify(callInput) ?? '{}';
  } catch {
    return '{}';
  }
}

/**
 * Settles one announced call to model text: the `output` projection wins, a
 * missing output falls back to the `error` projection as an `error:` result
 * (dispatch-shaped, never a throw — the model gets the text back).
 */
async function toolCallResultText(call: AgentStreamToolCall): Promise<string> {
  const output: unknown = call.output instanceof Promise ? await call.output : call.output;
  if (typeof output === 'string') return output;
  if (output !== undefined && output !== null) {
    try {
      const text: string | undefined = JSON.stringify(output);
      if (typeof text === 'string') return text;
    } catch {
      /* not serializable — fall through to the error projection */
    }
  }
  const failure: unknown = call.error instanceof Promise ? await call.error : call.error;
  if (failure instanceof Error && failure.message.length > 0) return `error: ${failure.message}`;
  if (typeof failure === 'string' && failure.length > 0) {
    return failure.startsWith('error:') ? failure : `error: ${failure}`;
  }
  return 'error: tool failed';
}

/** Usage of the final agent state (absent when unreported, never a throw). */
function usageOfFinalState(finalState: unknown): TokenUsage {
  const empty: TokenUsage = { input: 0, output: 0 };
  if (finalState === null || typeof finalState !== 'object') return empty;
  const messages: unknown = (finalState as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return empty;
  for (let index: number = messages.length - 1; index >= 0; index -= 1) {
    const candidate: unknown = messages[index];
    if (candidate !== null && typeof candidate === 'object' && 'usage_metadata' in candidate) {
      const folded: TokenUsage | undefined = usageOf(candidate as AIMessage);
      if (folded !== undefined) return addUsage(empty, folded);
    }
  }
  return empty;
}

/**
 * A4 streaming bridge: one agent turn via `streamEvents` v3 → existing
 * `TurnFrame`s (the protocol stays our own SSE, Vercel `useChat` chunk shapes
 * from `docs/ai-agents/langchain-api-notes.md` §6 are only a form reference).
 *
 * Frame contract (no new frame types — `TurnFrame.type` is an open string):
 * `step-start` → live `text-delta` (`{ delta, stepIndex }`, additive: the
 * `collect` fold ignores unknown types, the SSE mappers forward them as
 * `message.part.delta`) → `tool-call`/`tool-result` per announced call (same
 * immediate `called` link as the loop vehicle) → `step-finish` → `finish`.
 * Tool execution itself stays inside the agent tools (their `func`s settle
 * through the same dispatch/worker/MCP path as every other LC tool); the
 * `runTurn` loop vehicle is untouched and remains the non-streaming path.
 */
export async function streamAgentTurnToFrames(bridge: StreamAgentTurnInput): Promise<RunTurnResult> {
  const publish: PublishFrame = bridge.publish;
  const correlationId: string | undefined = bridge.correlationId;
  type StreamEventsOptions = Parameters<TurnAgent['streamEvents']>[1];
  type StreamEventsInput = Parameters<TurnAgent['streamEvents']>[0];
  const requestInput = {
    messages: toLangChainMessages(bridge.systemPrompt, bridge.messages),
  } as unknown as StreamEventsInput;
  const requestOptions = {
    ...bridge.config,
    version: 'v3',
    ...(bridge.signal !== undefined ? { signal: bridge.signal } : {}),
  } as unknown as StreamEventsOptions;
  const stream = (await bridge.agent.streamEvents(
    requestInput,
    requestOptions,
  )) as unknown as AgentStreamEventsV3;
  agentLogger.debug('[runner] stream turn subscribed', correlationId);
  publish({ type: 'step-start', data: { stepIndex: 0 } });
  let text: string = '';
  let textDeltas: number = 0;
  const settlements: Array<ToolSettlement> = [];
  const readMessages: Promise<void> = (async (): Promise<void> => {
    for await (const message of stream.messages) {
      for await (const delta of message.text) {
        if (typeof delta !== 'string' || delta.length === 0) continue;
        text += delta;
        textDeltas += 1;
        publish({ type: 'text-delta', data: { delta, stepIndex: 0 } });
      }
      if (message.toolCalls !== undefined) {
        // Argument chunks are liveness only: the authoritative call
        // (id/name/input + settled result) arrives via `stream.toolCalls`.
        for await (const chunk of message.toolCalls) {
          void chunk;
        }
      }
    }
  })();
  const readToolCalls: Promise<void> = (async (): Promise<void> => {
    let callIndex: number = 0;
    for await (const call of stream.toolCalls) {
      callIndex += 1;
      const callID: string =
        typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${callIndex}`;
      const name: string =
        typeof call.name === 'string' && call.name.length > 0 ? call.name : 'tool';
      publish({ type: 'tool-call', data: { callID, name, arguments: toolInputText(call.input) } });
      const result: string = await toolCallResultText(call);
      publish({ type: 'tool-result', data: { callID, name, result } });
      settlements.push({ callID, name, result });
    }
  })();
  await Promise.all([readMessages, readToolCalls]);
  const finalState: unknown = await stream.output;
  const usage: TokenUsage = usageOfFinalState(finalState);
  const finishReason: string = 'stop';
  publish({ type: 'step-finish', data: { stepIndex: 0, finishReason, text } });
  publish({ type: 'finish', data: { finishReason, text } });
  agentLogger.info(
    `[runner] stream turn done deltas=${textDeltas} tools=${settlements.length}`,
    correlationId,
  );
  return { text, steps: 1, finishReason, settlements, usage };
}

/** Transport adapter: one model step for the current request/messages. */
export type StepExecutor = (
  request: StepRequest,
  messages: Array<LoopMessage>,
) => Promise<LoopStep>;

/** Frame sink (the harness maps these onto SSE frames). */
export type PublishFrame = (frame: TurnFrame) => void;

/**
 * Checkpoint status persisted between segments (WEB-13 / B2).
 *
 * Contract-owned (`SessionCheckpointStatus` in `@rush-code/contracts`,
 * WEB-14 / B3): `CheckpointStatus` stays as the runner-local alias so
 * existing backend imports keep compiling.
 *
 * Mirrors the `agent_checkpoints.status` contract in
 * `common/db/schema.ts` (plain text, no CHECK — the contract owns the
 * enum, same call as `run_runs.status`): `running` after every
 * non-terminal segment, `completed` on a terminal stop, `limit_reached`
 * when the `CHECKPOINT_MAX_TOTAL_STEPS` ceiling is hit, `cancelled` on a
 * segment-boundary interrupt, `failed` on an unexpected throw.
 */
export type CheckpointStatus = SessionCheckpointStatus;

/** One durable pause/resume slice written between segments. */
export type AgentCheckpointInput = {
  sessionId: string;
  threadId: string;
  segmentIndex: number;
  stepsUsed: number;
  totalSteps: number;
  status: CheckpointStatus;
  pauseReason?: string;
  state?: Record<string, unknown>;
  tokensUsed: number;
};

/**
 * Checkpoint store port (WEB-13 / B2 seam).
 *
 * The runner never imports drizzle directly: production passes a thin
 * drizzle adapter over `agentCheckpoints` (upsert by
 * `(session_id, segment_index)`), specs pass an in-memory fake, and an
 * absent store means memory-only (the LangChain checkpointer thread under
 * `thread_id` stays the only resume state — no throw, no silent schema).
 */
export type CheckpointStore = {
  save: (checkpoint: AgentCheckpointInput) => Promise<void>;
};

/**
 * Validates a segment budget: a positive integer,
 * `CHECKPOINT_SEGMENT_STEPS` when omitted.
 */
export function resolveSegmentSteps(value?: number): number {
  const segmentSteps: number = value ?? CHECKPOINT_SEGMENT_STEPS;
  if (!Number.isInteger(segmentSteps) || segmentSteps < 1) {
    throw new Error('segmentSteps must be a positive integer');
  }
  return segmentSteps;
}

/**
 * Validates the total-steps ceiling: a positive integer,
 * `CHECKPOINT_MAX_TOTAL_STEPS` when omitted.
 */
export function resolveTotalCeiling(value?: number): number {
  const ceiling: number = value ?? CHECKPOINT_MAX_TOTAL_STEPS;
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    throw new Error('totalStepsCeiling must be a positive integer');
  }
  return ceiling;
}

/** Ceiling hit — the turn stops with `limit_reached`, never a throw. */
export function isLimitReached(totalSteps: number, ceiling?: number): boolean {
  return totalSteps >= resolveTotalCeiling(ceiling);
}

/**
 * Validates the long-session approval threshold (WEB-16 / C2): a positive
 * integer, `APPROVAL_AFTER_STEPS` (next to `CHECKPOINT_SEGMENT_STEPS` in
 * `./max-steps`) when omitted.
 */
export function resolveApprovalAfterSteps(value?: number): number {
  const threshold: number = value ?? APPROVAL_AFTER_STEPS;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error('approvalAfterSteps must be a positive integer');
  }
  return threshold;
}

/** Approval due — the turn crossed `APPROVAL_AFTER_STEPS` model steps. */
export function isApprovalDue(totalSteps: number, threshold?: number): boolean {
  return totalSteps >= resolveApprovalAfterSteps(threshold);
}

/**
 * Turn expired (WEB-24 / E3): the wall-clock `deadlineMs` (epoch millis,
 * stamped per turn by the caller) is reached. Undefined = no timeout —
 * specs and legacy callers without a deadline never expire. The `now`
 * parameter is a spec seam (default `Date.now()`); production never passes it.
 */
export function isTurnExpired(deadlineMs?: number, now: number = Date.now()): boolean {
  if (deadlineMs === undefined) return false;
  return now >= deadlineMs;
}

/** Thread of the turn (the checkpoint key every segment shares). */
export function resolveTurnThreadId(input: {
  threadId?: string;
  correlationId?: string;
  runId?: string;
  sessionId: string;
}): string {
  if (input.threadId !== undefined && input.threadId.trim().length > 0) return input.threadId;
  const fallback: string = input.correlationId ?? input.runId ?? input.sessionId;
  return `turn:${fallback}`;
}

export type RunTurnRequest = {
  sessionId: string;
  directory: string;
  messages: Array<LoopMessage>;
  step: StepExecutor;
  publish?: PublishFrame;
  concurrency?: number;
  maxSteps?: number;
  retry?: RetryPolicy;
  /** Run id used to build effect keys (`runId + stepSeq + toolCallId`). */
  runId?: string;
  /** Idempotency store of tool effects (replays committed results). */
  effects?: ToolEffectsStore;
  /** Execution mode of the turn (`ask` is read-only). */
  mode?: ToolMode;
  /** Correlation id of the attempt audit lines. */
  correlationId?: string;
  /** Checkpoint thread shared by every segment (defaults to `turn:<cid|run|session>`). */
  threadId?: string;
  /** Steps per segment (defaults to `CHECKPOINT_SEGMENT_STEPS`). */
  segmentSteps?: number;
  /** Total-steps ceiling (defaults to `CHECKPOINT_MAX_TOTAL_STEPS`). */
  totalStepsCeiling?: number;
  /**
   * Long-session approval threshold (WEB-16 / C2): crossing it on a segment
   * boundary parks the turn on `awaiting_approval` (durable checkpoint row,
   * interrupt-like stop, never a throw). Defaults to `APPROVAL_AFTER_STEPS`.
   */
  approvalAfterSteps?: number;
  /** Durable checkpoint sink (absent = memory-only, no throw). */
  checkpoints?: CheckpointStore;
  /**
   * Cooperative interrupt, read ONLY on a segment boundary (never
   * mid-segment): when it returns true the turn closes with `cancelled`
   * after persisting the boundary checkpoint.
   */
  shouldInterrupt?: () => boolean;
  /**
   * Downstream abort (WEB-24 / E3): armed server-side by the interrupt
   * endpoint (`SessionRuntimeStateService.requestCancel`), read ONLY on a
   * segment boundary next to `shouldInterrupt` — an aborted signal closes
   * the turn with `cancelled`, same durable row, same terminal frame.
   */
  signal?: AbortSignal;
  /**
   * Wall-clock deadline of the turn, epoch millis (WEB-24 / E3: stamped per
   * turn as `Date.now() + TURN_TIMEOUT_MS` by the caller). Read ONLY on a
   * segment boundary: an expired deadline parks the turn on `paused` with
   * `pause_reason='timeout'` (resumable, never a throw). Undefined = no
   * timeout (specs, legacy callers).
   */
  deadlineMs?: number;
};

/** Aggregated model-router audit of a turn (attempt order preserved). */
export type RunTurnMeta = {
  provider?: string;
  model?: string;
  attempts: Array<StepAttempt>;
  fallback?: { attempts: number; switchedFrom?: string; reason?: string };
};

export type RunTurnResult = {
  text: string;
  steps: number;
  finishReason: string;
  settlements: Array<ToolSettlement>;
  usage: TokenUsage;
  meta?: RunTurnMeta;
};

/**
 * Input of one agent segment (WEB-13 / B2 vehicle).
 *
 * One segment = one `createAgent` turn (A3 step-counter middleware inside,
 * A4 `streamAgentTurnToFrames` bridge outside) bounded by `segmentSteps`
 * model steps. The checkpointer thread (`configurable.thread_id`) is the
 * same across segments, so the agent resumes where the previous segment
 * stopped; the durable `agent_checkpoints` row is written by the outer
 * `runTurn` loop between segments, never mid-segment.
 */
export type RunAgentSegmentInput = {
  /** Resolved chain client of the segment (the agent's model node). */
  model: ChatOpenAI;
  /** Mode-filtered LangChain tools of the turn (rebound per segment). */
  tools: ReadonlyArray<DynamicStructuredTool>;
  /** Domain system prompt of the turn (omitted when empty). */
  systemPrompt: string;
  /** Turn messages (prior turns travel via the agent thread, `thread_id`). */
  messages: Array<LoopMessage>;
  /** Checkpoint thread shared by every segment. */
  threadId: string;
  /** Steps of this segment (defaults to `CHECKPOINT_SEGMENT_STEPS`). */
  segmentSteps?: number;
  /** Frame sink (the harness maps these onto SSE frames). */
  publish: PublishFrame;
  /** Downstream abort (forwarded to `streamEvents` when present). */
  signal?: AbortSignal;
  /** Checkpointer override (tests); production resolves it per process. */
  checkpointer?: TurnCheckpointer;
  /** Correlation id of the attempt audit lines. */
  correlationId?: string;
};

/**
 * Runs one agent segment: assembles the turn agent around the segment
 * budget (`createTurnAgent` + `createStepCounterMiddleware` from A3,
 * `recursionLimit` = segment budget) and streams it to frames (A4).
 * The caller (`runTurn` or a future resume path) owns the checkpoint
 * write and the ceiling — this function never touches `agent_checkpoints`.
 */
export async function runAgentSegment(input: RunAgentSegmentInput): Promise<RunTurnResult> {
  const segmentSteps: number = resolveSegmentSteps(input.segmentSteps);
  const agent: TurnAgent = createTurnAgent({
    model: input.model,
    tools: input.tools,
    systemPrompt: input.systemPrompt,
    maxSteps: segmentSteps,
    ...(input.checkpointer !== undefined ? { checkpointer: input.checkpointer } : {}),
  });
  const config: AgentStepConfig = buildAgentConfig(input.threadId, segmentSteps);
  return streamAgentTurnToFrames({
    agent,
    systemPrompt: input.systemPrompt,
    messages: input.messages,
    config,
    publish: input.publish,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });
}

/**
 * SessionRunnerService — step → dispatch → nextRequest orchestration.
 *
 * Transport-agnostic by design: the caller supplies the single-step executor
 * (model call) and the frame sink. Protections are structural, not optional:
 * a hard max-steps budget (`max-steps.ts`), a tool-loop guard (WEB-23 / E2:
 * same pair three times in a row with the same result hash parks the turn on
 * `paused`/`loop`, no auto-restart) and bounded per-step retries
 * (`retry.ts`). Tool calls settle in call order through the shared dispatch
 * (unknown tool / bad JSON / jail escape = error-result, never a throw).
 *
 * WEB-13 / B2 segmentation: the turn runs in segments of
 * `CHECKPOINT_SEGMENT_STEPS` model steps with a durable `agent_checkpoints`
 * row (under the shared `thread_id`) written BETWEEN segments — never
 * mid-segment. The outer `CHECKPOINT_MAX_TOTAL_STEPS` ceiling closes the
 * turn with `limit_reached` (a terminal `finish` frame + a `limit_reached`
 * checkpoint row, never a throw). WEB-16 / C2 approval: crossing
 * `APPROVAL_AFTER_STEPS` on a segment boundary parks the turn on
 * `awaiting_approval` (durable checkpoint row + the reused C1
 * `session.approval.requested` frame + a terminal `finish` frame with
 * `awaiting_approval`, never a throw). Cooperative interruption
 * (`shouldInterrupt` + `signal.aborted`, WEB-24 / E3 server-side cancel) and the wall-clock `deadlineMs` (WEB-24 / E3 `paused`/`timeout`) are read only on a segment boundary. The SSE frame
 * contract is unchanged apart from the reused approval frame
 * (`step-start` / `text-delta` / `tool-call` / `tool-result` /
 * `step-finish` / `finish` + `session.approval.requested`).
 *
 * WEB-22 / E1 boot: rows still `running` from a previous process become
 * `paused`/`restart` in `onModuleInit` (same segment, same `thread_id`,
 * never an auto-resume — resume stays on demand through
 * `InProcessTurnService.resume` with the parked `thread_id`).
 */
@Injectable()
export class SessionTurnRunnerService implements OnModuleInit {
  private readonly logger: AppLogger = new AppLogger(SessionTurnRunnerService.name);

  constructor(
    private readonly dispatch: ToolDispatchService,
    @Optional() private readonly history?: SessionHistoryRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.pauseRunningOnBoot();
  }

  /**
   * Boot pause (WEB-22 / E1): every checkpoint row still `running` becomes
   * `paused` with `pause_reason='restart'` on the SAME segment and thread.
   * Writes ride the B2 `CheckpointStore` seam over
   * `history.saveCheckpoint` (never drizzle directly); the opaque `state`
   * stays untouched so a later on-demand resume keeps the thread.
   * Best-effort: absent history (specs) or a DB outage only warns, never
   * throws — boot never dies on a stale checkpoint. Answers the paused
   * count. No auto-resume here by design.
   */
  async pauseRunningOnBoot(): Promise<number> {
    const history: SessionHistoryRepository | undefined = this.history;
    if (history === undefined) return 0;
    try {
      const running: Array<{
        sessionId: string;
        threadId: string | null;
        segmentIndex: number;
        stepsUsed: number;
        totalSteps: number;
        tokensUsed: number;
      }> = await history.listRunningCheckpoints();
      if (running.length === 0) return 0;
      const checkpoints: CheckpointStore = {
        save: async (checkpoint: AgentCheckpointInput): Promise<void> => {
          await history.saveCheckpoint({
            sessionId: checkpoint.sessionId,
            threadId: checkpoint.threadId,
            segmentIndex: checkpoint.segmentIndex,
            stepsUsed: checkpoint.stepsUsed,
            totalSteps: checkpoint.totalSteps,
            status: checkpoint.status,
            ...(checkpoint.pauseReason !== undefined
              ? { pauseReason: checkpoint.pauseReason }
              : {}),
            ...(checkpoint.state !== undefined ? { state: checkpoint.state } : {}),
            tokensUsed: checkpoint.tokensUsed,
          });
        },
      };
      for (const row of running) {
        const threadId: string =
          row.threadId !== null && row.threadId.length > 0
            ? row.threadId
            : resolveTurnThreadId({ sessionId: row.sessionId });
        await checkpoints.save({
          sessionId: row.sessionId,
          threadId,
          segmentIndex: row.segmentIndex,
          stepsUsed: row.stepsUsed,
          totalSteps: row.totalSteps,
          status: 'paused',
          pauseReason: 'restart',
          tokensUsed: row.tokensUsed,
        });
      }
      this.logger.info(`[runner] boot pause paused=${running.length} reason=restart`);
      return running.length;
    } catch (error) {
      this.logger.warn('[runner] boot pause skipped code=db_unavailable');
      this.logger.debug((error as Error).message);
      return 0;
    }
  }

  async runTurn(request: RunTurnRequest): Promise<RunTurnResult> {
    const maxSteps: number = resolveMaxSteps(request.maxSteps);
    const segmentSteps: number = resolveSegmentSteps(request.segmentSteps);
    const ceiling: number = resolveTotalCeiling(request.totalStepsCeiling);
    const approvalAfterSteps: number = resolveApprovalAfterSteps(request.approvalAfterSteps);
    const effectiveCeiling: number = Math.min(maxSteps, ceiling);
    const threadId: string = resolveTurnThreadId({
      ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
      ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      sessionId: request.sessionId,
    });
    const concurrency: number | undefined = request.concurrency;
    const retry: RetryPolicy = request.retry ?? DEFAULT_RETRY_POLICY;
    const publish: PublishFrame = request.publish ?? (() => undefined);
    let messages: Array<LoopMessage> = [...request.messages];
    let usage: TokenUsage = { input: 0, output: 0 };
    let settlements: Array<ToolSettlement> = [];
    const attempts: Array<StepAttempt> = [];
    let metaProvider: string | undefined;
    let metaModel: string | undefined;
    let metaFallback: RunTurnMeta['fallback'];

    const saveCheckpoint = async (input: {
      segmentIndex: number;
      stepsUsed: number;
      totalSteps: number;
      status: CheckpointStatus;
      pauseReason?: string;
    }): Promise<void> => {
      if (request.checkpoints === undefined) return;
      try {
        await request.checkpoints.save({
          sessionId: request.sessionId,
          threadId,
          segmentIndex: input.segmentIndex,
          stepsUsed: input.stepsUsed,
          totalSteps: input.totalSteps,
          status: input.status,
          ...(input.pauseReason !== undefined ? { pauseReason: input.pauseReason } : {}),
          tokensUsed: usage.input + usage.output,
        });
      } catch {
        this.logger.warn(
          `[runner] checkpoint save failed segment=${input.segmentIndex} status=${input.status}`,
          request.correlationId,
        );
      }
    };

    const finishMeta = (): RunTurnMeta => ({
      ...(metaProvider !== undefined ? { provider: metaProvider } : {}),
      ...(metaModel !== undefined ? { model: metaModel } : {}),
      attempts,
      ...(metaFallback !== undefined ? { fallback: metaFallback } : {}),
    });

    const partialTextOf = (): string =>
      messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content)
        .join('');

    const closeLimitReached = async (totalSteps: number, segmentIndex: number): Promise<RunTurnResult> => {
      const partialText: string = partialTextOf();
      await saveCheckpoint({
        segmentIndex,
        stepsUsed: 0,
        totalSteps,
        status: 'limit_reached',
        pauseReason: 'limit',
      });
      publish({ type: 'finish', data: { finishReason: 'limit_reached', text: partialText } });
      this.logger.warn(
        `[runner] total steps ceiling reached ceiling=${ceiling} steps=${totalSteps} thread=${threadId}`,
        request.correlationId,
      );
      return {
        text: partialText,
        steps: totalSteps,
        finishReason: 'limit_reached',
        settlements,
        usage,
        meta: finishMeta(),
      };
    };

    const closeAwaitingApproval = async (
      stepsAtBoundary: number,
      segmentIndex: number,
    ): Promise<RunTurnResult> => {
      const partialText: string = partialTextOf();
      const reason: string = `long session: ${stepsAtBoundary} steps need approval`;
      await saveCheckpoint({
        segmentIndex,
        stepsUsed: 0,
        totalSteps: stepsAtBoundary,
        status: 'awaiting_approval',
        pauseReason: 'approval',
      });
      publish({
        type: 'session.approval.requested',
        data: { sessionID: request.sessionId, reason },
      });
      publish({ type: 'finish', data: { finishReason: 'awaiting_approval', text: partialText } });
      this.logger.info(
        `[runner] approval parked at segment boundary segment=${segmentIndex} steps=${stepsAtBoundary} thread=${threadId}`,
        request.correlationId,
      );
      return {
        text: partialText,
        steps: stepsAtBoundary,
        finishReason: 'awaiting_approval',
        settlements,
        usage,
        meta: finishMeta(),
      };
    };

    const closeTimeoutPaused = async (
      stepsNow: number,
      checkpointSegment: number,
    ): Promise<RunTurnResult> => {
      const partialText: string = partialTextOf();
      await saveCheckpoint({
        segmentIndex: checkpointSegment,
        stepsUsed: 0,
        totalSteps: stepsNow,
        status: 'paused',
        pauseReason: 'timeout',
      });
      publish({ type: 'finish', data: { finishReason: 'paused', text: partialText } });
      this.logger.warn(
        `[runner] turn timed out steps=${stepsNow} thread=${threadId}`,
        request.correlationId,
      );
      return {
        text: partialText,
        steps: stepsNow,
        finishReason: 'paused',
        settlements,
        usage,
        meta: finishMeta(),
      };
    };

    const closeLoopPaused = async (
      stepsNow: number,
      checkpointSegment: number,
      recent: Array<LoopCallRecord>,
    ): Promise<RunTurnResult> => {
      const hint: string = formatLoopHint(recent);
      await saveCheckpoint({
        segmentIndex: checkpointSegment,
        stepsUsed: 0,
        totalSteps: stepsNow,
        status: 'paused',
        pauseReason: 'loop',
      });
      publish({ type: 'finish', data: { finishReason: 'paused', text: hint } });
      const names: string = recent.map((entry) => entry.name).join(',');
      this.logger.warn(
        `[runner] tool loop paused calls=${names} steps=${stepsNow} thread=${threadId}`,
        request.correlationId,
      );
      return {
        text: hint,
        steps: stepsNow,
        finishReason: 'paused',
        settlements,
        usage,
        meta: finishMeta(),
      };
    };

    let totalSteps: number = 0;
    let segmentIndex: number = 0;
    const loopHistory: Array<LoopCallRecord> = [];
    for (;;) {
      if (totalSteps >= effectiveCeiling) {
        if (effectiveCeiling === ceiling) return closeLimitReached(totalSteps, segmentIndex);
        const partialText: string = partialTextOf();
        this.logger.warn(
          `[runner] max steps exceeded maxSteps=${maxSteps} steps=${totalSteps}`,
          request.correlationId,
        );
        await saveCheckpoint({
          segmentIndex,
          stepsUsed: 0,
          totalSteps,
          status: 'failed',
          pauseReason: 'max-steps',
        });
        throw new MaxStepsExceededError(maxSteps, {
          steps: totalSteps,
          usage: { input: usage.input, output: usage.output },
          partialText,
        });
      }
      const segmentBudget: number = Math.min(segmentSteps, effectiveCeiling - totalSteps);
      let segmentUsed: number = 0;
      for (let inSegment: number = 0; inSegment < segmentBudget; inSegment += 1) {
        const index: number = totalSteps + inSegment;
        publish({ type: 'step-start', data: { stepIndex: index } });
        const step: LoopStep = await withRetry(
          () => request.step(nextRequest({ text: '', calls: [], finishReason: null }, index), messages),
          retry,
        );
        if (step.meta?.attempts) {
          for (const attempt of step.meta.attempts) {
            this.logger.info(
              `[runner] model attempt provider=${attempt.provider} model=${attempt.model} attempt=${attempt.attempt} outcome=${attempt.outcome} reason=${attempt.reason} latencyMs=${attempt.latencyMs}`,
              request.correlationId,
            );
            attempts.push(attempt);
          }
        }
        if (step.meta) {
          // Aggregate all attempts in order; the final provider/model/fallback
          // come from the last step that reported meta.
          metaProvider = step.meta.provider;
          metaModel = step.meta.model;
          metaFallback = step.meta.fallback;
        }
        usage = addUsage(usage, step.usage);
        publish({
          type: 'step-finish',
          data: { stepIndex: index, finishReason: step.finishReason ?? '', text: step.text },
        });
        const calls: Array<ToolCall> = pendingCalls(step);
        if (calls.length === 0) {
          publish({
            type: 'finish',
            data: { finishReason: step.finishReason ?? 'stop', text: step.text },
          });
          this.logger.info(
            `[runner] turn done steps=${index + 1} tools=${settlements.length} thread=${threadId}`,
            request.correlationId,
          );
          await saveCheckpoint({
            segmentIndex,
            stepsUsed: segmentUsed + 1,
            totalSteps: index + 1,
            status: 'completed',
          });
          return {
            text: step.text,
            steps: index + 1,
            finishReason: step.finishReason ?? 'stop',
            settlements,
            usage,
            meta: finishMeta(),
          };
        }
        const keyed: Array<ToolCall> = request.runId
          ? calls.map((call) => ({
              ...call,
              effectKey: `${request.runId}:${index}:${call.id}`,
            }))
          : calls;
        // Immediate broadcast of every call (durable `called` link upstream):
        // the turns layer persists each `tool-call` as a kind=tool row
        // parented to the tip, so a later throw/abort (max-steps/stop/
        // interrupt) never loses the already-broadcast calls.
        for (const call of calls) {
          publish({
            type: 'tool-call',
            data: { callID: call.id, name: call.name, arguments: call.arguments },
          });
        }
        const context: ToolContext = {
          directory: request.directory,
          sessionId: request.sessionId,
          ...(request.mode ? { mode: request.mode } : {}),
        };
        const round: Array<ToolSettlement> = await this.dispatch.dispatch(
          keyed,
          context,
          concurrency,
          request.effects,
        );
        for (const settlement of round) {
          publish({ type: 'tool-result', data: { ...settlement } });
        }
        settlements = [...settlements, ...round];
        for (let callIndex: number = 0; callIndex < calls.length; callIndex += 1) {
          const call: ToolCall = calls[callIndex] as ToolCall;
          const settlement: ToolSettlement | undefined = round[callIndex];
          loopHistory.push(
            recordLoopCall(call.name, call.arguments, settlement?.result ?? ''),
          );
        }
        if (isLoopTriplet(loopHistory)) {
          const recent: Array<LoopCallRecord> = takeLoopRecent(loopHistory);
          return closeLoopPaused(totalSteps + segmentUsed + 1, segmentIndex, recent);
        }
        messages = [...messages, ...stepMessages(step, round)];
        segmentUsed += 1;
      }
      totalSteps += segmentUsed;
      // Segment boundary: the ONLY place where interruption, timeout,
      // approval, and the ceiling are observed. Mid-segment abort would
      // strand the agent thread and the already-broadcast tool links — a
      // boundary stop keeps both intact.
      const interrupted: boolean =
        request.shouldInterrupt?.() === true || request.signal?.aborted === true;
      if (interrupted) {
        const partialText: string = partialTextOf();
        await saveCheckpoint({
          segmentIndex,
          stepsUsed: segmentUsed,
          totalSteps,
          status: 'cancelled',
          pauseReason: 'cancelled',
        });
        publish({ type: 'finish', data: { finishReason: 'cancelled', text: partialText } });
        this.logger.info(
          `[runner] turn cancelled at segment boundary segment=${segmentIndex} steps=${totalSteps} thread=${threadId}`,
          request.correlationId,
        );
        return {
          text: partialText,
          steps: totalSteps,
          finishReason: 'cancelled',
          settlements,
          usage,
          meta: finishMeta(),
        };
      }
      if (isApprovalDue(totalSteps, approvalAfterSteps)) {
        return closeAwaitingApproval(totalSteps, segmentIndex + 1);
      }
      if (isTurnExpired(request.deadlineMs)) {
        return closeTimeoutPaused(totalSteps, segmentIndex + 1);
      }
      if (totalSteps >= effectiveCeiling) {
        if (effectiveCeiling === ceiling) return closeLimitReached(totalSteps, segmentIndex + 1);
        const partialText: string = partialTextOf();
        this.logger.warn(
          `[runner] max steps exceeded maxSteps=${maxSteps} steps=${totalSteps}`,
          request.correlationId,
        );
        await saveCheckpoint({
          segmentIndex: segmentIndex + 1,
          stepsUsed: 0,
          totalSteps,
          status: 'failed',
          pauseReason: 'max-steps',
        });
        throw new MaxStepsExceededError(maxSteps, {
          steps: totalSteps,
          usage: { input: usage.input, output: usage.output },
          partialText,
        });
      }
      await saveCheckpoint({
        segmentIndex,
        stepsUsed: segmentUsed,
        totalSteps,
        status: 'running',
      });
      segmentIndex += 1;
    }
  }
}

/** Provider tool_choice of one step (`required` only on the first step). */
export type StepToolChoice = 'required' | 'auto' | 'none';

/**
 * Dependencies of `createStepExecutor` (card C2).
 *
 * The executor owns ONLY the model call: it walks the shared model chain
 * (`runModelChain`), builds one `ChatOpenAI` per candidate
 * (`createModelClient` + per-user key) and returns a `LoopStep` (text, raw
 * tool-call arguments, finish reason, usage, router meta). It never dispatches
 * a tool — `runTurn` owns the dispatch step, so a model call alone can never
 * execute an effect (R1).
 */
export type StepExecutorDeps = {
  /** Caller owning the per-provider key. */
  userId: string;
  /** Domain system prompt of the turn (system role). */
  system: string;
  /** LangChain tools handed to `bindTools` (already mode-filtered). */
  tools: ReadonlyArray<DynamicStructuredTool>;
  /** Tool choice of one step (the runner forces `required` only on step 0). */
  toolChoiceFromRequest: (request: StepRequest) => StepToolChoice;
  /** Chain to walk; defaults to the in-code `MODEL_CHAIN`. */
  chain?: ReadonlyArray<ModelChainEntry>;
  /** Shared per-consumer vault (ciphertext store + round-robin picks). */
  keys: VaultService;
  /** Existing KEK envelope (decrypt in memory only). */
  crypto: CryptoService;
  /** In-process `fetch` adapter factory for `inprocess-opencode`. */
  opencodeFetch: OpencodeModelFetch;
  /**
   * Test seam: overrides the chain client factory, so a spec can answer a fake
   * `ChatOpenAI` without a key or a network hop. Absent in production.
   */
  createClient?: (entry: ModelChainEntry) => Promise<unknown>;
  /** Correlation id kept for logs/audit. */
  correlationId?: string;
};

/** Text of a LangChain message content value (string or text parts). */
function contentText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) =>
      typeof part === 'string'
        ? part
        : (part as { type?: string; text?: unknown }).type === 'text'
          ? String((part as { text?: unknown }).text ?? '')
          : '',
    )
    .join('');
}

/** Raw OpenAI tool call as `@langchain/openai` keeps it in `additional_kwargs`. */
type RawOpenAiToolCall = {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

/** Raw OpenAI tool calls of one response (empty when the provider sent none). */
function rawOpenAiToolCalls(response: AIMessage): Array<RawOpenAiToolCall> {
  const value: unknown = response.additional_kwargs.tool_calls;
  if (!Array.isArray(value)) return [];
  const calls: Array<RawOpenAiToolCall> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    calls.push(entry as RawOpenAiToolCall);
  }
  return calls;
}

/**
 * Model tool calls as `ToolCall` values: `arguments` stays the RAW JSON text
 * the model produced (never parsed here — `ToolDispatchService` parses it so
 * malformed JSON becomes a retryable error-result instead of a throw). The
 * raw string is read from `additional_kwargs.tool_calls`; a provider that
 * only gives normalized calls falls back to `JSON.stringify(args)`.
 */
function toolCallsFromResponse(response: AIMessage): Array<ToolCall> {
  const raw: Array<RawOpenAiToolCall> = rawOpenAiToolCalls(response);
  const structured = response.tool_calls ?? [];
  if (structured.length === 0) {
    const fromRaw: Array<ToolCall> = [];
    raw.forEach((call, index) => {
      const name: unknown = call.function?.name;
      if (typeof name !== 'string' || name.length === 0) return;
      const id: unknown = call.id;
      fromRaw.push({
        id: typeof id === 'string' && id.length > 0 ? id : `call_${index}`,
        name,
        arguments:
          typeof call.function?.arguments === 'string' ? call.function.arguments : '{}',
      });
    });
    return fromRaw;
  }
  return structured.map((call, index) => {
    const rawArguments: unknown = raw[index]?.function?.arguments;
    const rawId: unknown = raw[index]?.id;
    return {
      id: call.id ?? (typeof rawId === 'string' ? rawId : `call_${index}`),
      name: call.name,
      arguments:
        typeof rawArguments === 'string' ? rawArguments : JSON.stringify(call.args ?? {}),
    };
  });
}

/** Token usage of one response (`usage_metadata`), absent when unreported. */
function usageOf(response: AIMessage): TokenUsage | undefined {
  const usage = response.usage_metadata;
  if (!usage) return undefined;
  const inputDetails = usage.input_token_details;
  const outputDetails = usage.output_token_details;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    ...(outputDetails?.reasoning !== undefined ? { reasoning: outputDetails.reasoning } : {}),
    ...(inputDetails?.cache_read !== undefined ? { cacheRead: inputDetails.cache_read } : {}),
    ...(inputDetails?.cache_creation !== undefined
      ? { cacheWrite: inputDetails.cache_creation }
      : {}),
  };
}

/** OpenAI finish reason: calls win over a provider `stop`, `length` is kept. */
function finishReasonOf(
  response: AIMessage,
  calls: ReadonlyArray<ToolCall>,
): 'tool_calls' | 'stop' | 'length' {
  if (calls.length > 0) return 'tool_calls';
  const raw: unknown = response.response_metadata?.finish_reason;
  return raw === 'length' ? 'length' : 'stop';
}

/** One model response → the runner's `LoopStep` (raw args, usage, finish). */
function loopStepFromResponse(response: AIMessage): LoopStep {
  const calls: Array<ToolCall> = toolCallsFromResponse(response);
  const usage: TokenUsage | undefined = usageOf(response);
  return {
    text: contentText(response.content),
    calls,
    finishReason: finishReasonOf(response, calls),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/** Tool-call arguments for the assistant echo (bad JSON echoes `{}`). */
function parseEchoArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Loop message → LangChain message (system/user/assistant/tool). */
function toLangChainMessage(message: LoopMessage): BaseMessage {
  if (message.role === 'system') return new SystemMessage(message.content);
  if (message.role === 'user') return new HumanMessage(message.content);
  if (message.role === 'tool') {
    return new ToolMessage({
      content: message.content,
      tool_call_id: message.toolCallID ?? '',
      ...(message.toolName !== undefined ? { name: message.toolName } : {}),
    });
  }
  const toolCalls =
    message.toolCalls !== undefined && message.toolCalls.length > 0
      ? message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          args: parseEchoArguments(call.arguments),
          type: 'tool_call' as const,
        }))
      : undefined;
  return new AIMessage({
    content: message.content,
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
  });
}

/**
 * System prompt + conversation: the agent's `system` is prepended once. An
 * explicit `system` row already present in the history is not duplicated, and
 * an empty prompt adds nothing.
 */
function toLangChainMessages(
  system: string,
  messages: Array<LoopMessage>,
): Array<BaseMessage> {
  const mapped: Array<BaseMessage> = messages.map(toLangChainMessage);
  if (system.trim().length === 0 || messages[0]?.role === 'system') return mapped;
  return [new SystemMessage(system), ...mapped];
}

/** Router meta → runner `StepMeta` (same fixed fields, no secrets). */
function stepMetaOf(meta: ModelRunMeta): StepMeta {
  return {
    provider: meta.provider,
    model: meta.model,
    attempts: meta.attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      attempt: attempt.attempt,
      outcome: attempt.outcome,
      reason: attempt.reason,
      latencyMs: attempt.latencyMs,
    })),
    fallback: meta.fallback,
  };
}

/**
 * Builds the `StepExecutor` of one turn (card C2; createAgent adapter since A2).
 *
 * One `step()` call = one `runModelChain` walk: the per-user key is resolved
 * lazily inside the chain (`loadProviderKey`), the transport is chosen by the
 * provider entry (`createModelClient`), and the step binds the mode-filtered
 * LangChain tools with the step's tool choice. Each attempt additionally
 * assembles a `createAgent` turn instance around the resolved client
 * (step-counter middleware + resolved checkpointer + recursionLimit/thread
 * config) as live A2 wiring; the single-step vehicle stays `bindTools` and no
 * tool is executed here — `runTurn` owns the dispatch step, so a model call
 * alone can never execute an effect (R1).
 */
export function createStepExecutor(deps: StepExecutorDeps): StepExecutor {
  const createClient: (entry: ModelChainEntry) => Promise<unknown> =
    deps.createClient ??
    (async (entry: ModelChainEntry): Promise<unknown> => {
      const key: string = await loadProviderKey(
        { keys: deps.keys, crypto: deps.crypto },
        deps.userId,
        entry.provider,
        deps.correlationId,
      );
      const fetchAdapter: typeof fetch | undefined =
        entry.transport === 'inprocess-opencode'
          ? deps.opencodeFetch.create(deps.userId, entry.provider, deps.correlationId)
          : undefined;
      return createModelClient(entry, key, fetchAdapter !== undefined ? { fetch: fetchAdapter } : {});
    });
  // Checkpointer thread of this executor (one thread per turn-construction;
  // the outer messages array stays the source of truth until the A4 bridge
  // drives the loop through the agent thread).
  const threadId: string = `turn:${deps.correlationId ?? deps.userId}`;

  return async (request: StepRequest, messages: Array<LoopMessage>): Promise<LoopStep> => {
    const toolChoice: StepToolChoice = deps.toolChoiceFromRequest(request);
    const result = await runModelChain<LoopStep>({
      ...(deps.chain !== undefined ? { chain: deps.chain } : {}),
      ...(deps.correlationId !== undefined ? { correlationId: deps.correlationId } : {}),
      createClient,
      run: async (client) => {
        const chat = client as ChatOpenAI;
        // Live adapter wiring (A2): assemble the turn agent around the same
        // resolved client (createAgent + step-counter middleware + resolved
        // checkpointer). The single-step vehicle stays `bindTools`: tool
        // execution (effect keys, concurrency, idempotent effects) and the SSE
        // frames stay in `runTurn` — streaming rides `streamAgentTurnToFrames`
        // (the A4 bridge).
        createTurnAgent({ model: chat, tools: deps.tools, systemPrompt: deps.system });
        const agentConfig: AgentStepConfig = buildAgentConfig(threadId);
        const bound =
          deps.tools.length > 0
            ? chat.bindTools([...deps.tools], { tool_choice: toolChoice })
            : chat;
        const response = await bound.invoke(toLangChainMessages(deps.system, messages), agentConfig);
        return loopStepFromResponse(response as AIMessage);
      },
    });
    return { ...result.value, meta: stepMetaOf(result.meta) };
  };
}

