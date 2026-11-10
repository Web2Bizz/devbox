import { Injectable } from '@nestjs/common';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { ChatOpenAI } from '@langchain/openai';
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
import { assertStepBudget, DEFAULT_MAX_STEPS } from './max-steps';
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from './retry';

/** Transport adapter: one model step for the current request/messages. */
export type StepExecutor = (
  request: StepRequest,
  messages: Array<LoopMessage>,
) => Promise<LoopStep>;

/** Frame sink (the harness maps these onto SSE frames). */
export type PublishFrame = (frame: TurnFrame) => void;

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
 * SessionRunnerService — step → dispatch → nextRequest orchestration.
 *
 * Transport-agnostic by design: the caller supplies the single-step executor
 * (model call) and the frame sink. Protections are structural, not optional:
 * a hard max-steps budget (`max-steps.ts`) and bounded per-step retries
 * (`retry.ts`). Tool calls settle in call order through the shared dispatch
 * (unknown tool / bad JSON / jail escape = error-result, never a throw).
 */
@Injectable()
export class SessionTurnRunnerService {
  private readonly logger: AppLogger = new AppLogger(SessionTurnRunnerService.name);

  constructor(private readonly dispatch: ToolDispatchService) {}

  async runTurn(request: RunTurnRequest): Promise<RunTurnResult> {
    const maxSteps: number = request.maxSteps ?? DEFAULT_MAX_STEPS;
    const concurrency: number | undefined = request.concurrency;
    const retry: RetryPolicy = request.retry ?? DEFAULT_RETRY_POLICY;
    const publish: PublishFrame = request.publish ?? (() => undefined);
    let messages: Array<LoopMessage> = [...request.messages];
    let usage: TokenUsage = { input: 0, output: 0 };
    let settlements: Array<ToolSettlement> = [];
    const stepIndex: number = 0;
    const attempts: Array<StepAttempt> = [];
    let metaProvider: string | undefined;
    let metaModel: string | undefined;
    let metaFallback: RunTurnMeta['fallback'];

    for (let index: number = stepIndex; ; index += 1) {
      assertStepBudget(index, maxSteps);
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
          `[runner] turn done steps=${index + 1} tools=${settlements.length}`,
          request.correlationId,
        );
        return {
          text: step.text,
          steps: index + 1,
          finishReason: step.finishReason ?? 'stop',
          settlements,
          usage,
          meta: {
            ...(metaProvider !== undefined ? { provider: metaProvider } : {}),
            ...(metaModel !== undefined ? { model: metaModel } : {}),
            attempts,
            ...(metaFallback !== undefined ? { fallback: metaFallback } : {}),
          },
        };
      }
      const keyed: Array<ToolCall> = request.runId
        ? calls.map((call) => ({
            ...call,
            effectKey: `${request.runId}:${index}:${call.id}`,
          }))
        : calls;
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
      messages = [...messages, ...stepMessages(step, round)];
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
 * Builds the `StepExecutor` of one turn (card C2).
 *
 * One `step()` call = one `runModelChain` walk: the per-user key is resolved
 * lazily inside the chain (`loadProviderKey`), the transport is chosen by the
 * provider entry (`createModelClient`), and the step binds the mode-filtered
 * LangChain tools with the step's tool choice. No tool is executed here and
 * `ToolDispatchService` is never imported into the model call (R1).
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

  return async (request: StepRequest, messages: Array<LoopMessage>): Promise<LoopStep> => {
    const toolChoice: StepToolChoice = deps.toolChoiceFromRequest(request);
    const result = await runModelChain<LoopStep>({
      ...(deps.chain !== undefined ? { chain: deps.chain } : {}),
      ...(deps.correlationId !== undefined ? { correlationId: deps.correlationId } : {}),
      createClient,
      run: async (client) => {
        const chat = client as ChatOpenAI;
        const bound =
          deps.tools.length > 0
            ? chat.bindTools([...deps.tools], { tool_choice: toolChoice })
            : chat;
        const response = await bound.invoke(messages.map(toLangChainMessage));
        return loopStepFromResponse(response as AIMessage);
      },
    });
    return { ...result.value, meta: stepMetaOf(result.meta) };
  };
}

