import { ConflictException, HttpException, Injectable } from '@nestjs/common';
import type { ToolView } from '@rush-code/contracts';
import { CryptoService } from '@common/crypto/crypto.service';
import {
  ExternalServiceError,
  fromUnknown,
} from '@common/external/external-error';
import { AppLogger } from '@common/logger';
import { VaultService } from '@common/vault/vault.service';
import { OpencodeModelFetch } from '../../../opencode/opencode-model-fetch';
import {
  InMemoryToolEffectsStore,
  ToolDispatchService,
} from '../../../tool-dispatch/tool-dispatch.service';
import { ToolRegistryService } from '../../../tool-registry/tool-registry.service';
import type { ToolMode } from '../../../tool-runtime/tool-runtime.types';
import {
  createLangChainTools,
  filterLangChainToolsForMode,
  type LangChainToolBinding,
} from '../../../tools/utils/langchain-tools/langchain-tools.util';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { SessionMessage } from '../../sessions.dto';
import type { SessionTurnInput } from '../../sessions.types';
import { isMissingKey } from '../../utils/session-errors';
import { SessionFrameBufferService } from '../events/session-frame-buffer.service';
import {
  createStepExecutor,
  SessionTurnRunnerService,
  type CheckpointStore,
  type StepExecutor,
} from '../runner/runner.service';
import type { LoopMessage, TurnFrame } from '../runner/loop';
import { MaxStepsExceededError, TURN_TIMEOUT_MS } from '../runner/max-steps';
import { SessionRuntimeStateService } from '../state/session-runtime-state.service';
import { TurnWorkspaceService } from '../workspace/turn-workspace.service';

/** Chunk size of the contract-narrowed delta frames. */
const SSE_CHUNK: number = 200;

/** Fixed, secret-free failure text of the terminal frames (never a stack). */
export const IN_PROCESS_FAILED_MESSAGE: string = 'не удалось выполнить ход, повторите позже';

/** Typed failure code of the terminal frames (contract `code`, never a secret). */
export type InProcessFailedCode = 'in-process-failed' | 'max-steps-exceeded';

/**
 * System prompt of the in-process auto turn: the model works only through the
 * LangChain tools of the project, and the visible result is the workspace.
 */
const AUTO_SYSTEM_PROMPT: string =
  'Ты — Auto-режим Rush Code. Работай в workspace проекта только через инструменты: читай и ищи файлы, правь их и запускай команды. Результат — реальные файлы проекта плюс краткая сводка сделанного. ЖЁСТКОЕ ПРАВИЛО shell: один вызов = одна команда без shell-связок — запрещены &&, ;, |, &, cd, env-префиксы вида KEY=value перед командой и фоновые процессы; длинные проверки разбивай на отдельные шаги-вызовы; паттерн grep, начинающийся с -, передавай только через -- или -e; команды короткие (до 15с), dev-серверы и watch не запускать.';

/** Native views travel to the dispatcher under their bare registry name. */
function nativeWireName(view: ToolView): string {
  return view.id.startsWith('native:') ? view.id.slice('native:'.length) : view.id;
}

/**
 * InProcessTurnService — the `auto` turn executed by rush-code itself.
 *
 * The model answers through the shared chain router (LangChain tools bound by
 * mode), tool calls settle through `ToolDispatchService` in the runner loop,
 * and the files are really written (the turn runs in the gated project
 * directory, the pre-turn tree is captured for revert). The embedded host is
 * NOT prompted: `auto` no longer depends on a bound host session.
 *
 * Durable chain (0012): every broadcast persists immediately as a kind=tool
 * row (called on `tool-call`, done/failed on `tool-result`,
 * parent=tip, tip=prev-link ?? receipt), the assistant text closes the
 * chain on the last tip. Idempotent by broadcast id
 * (`receipt:callID:called|result` + onConflictDoNothing + tip dedupe), so a
 * redelivered frame never rewinds the chain. Detail is a single-line 500-char
 * redacted snippet, never full payloads/secrets. A late answer after
 * interrupt() is dropped (the partial commit already belongs to stop()), and
 * the busy marker is always cleared. Partial tool links survive max-steps /
 * throw / abort: they are persisted before the terminal failure frames.
 */
@Injectable()
export class InProcessTurnService {
  constructor(
    private readonly history: SessionHistoryRepository,
    private readonly workspace: TurnWorkspaceService,
    private readonly state: SessionRuntimeStateService,
    private readonly buffer: SessionFrameBufferService,
    private readonly runner: SessionTurnRunnerService,
    private readonly registry: ToolRegistryService,
    private readonly dispatch: ToolDispatchService,
    private readonly keys: VaultService,
    private readonly crypto: CryptoService,
    private readonly opencodeFetch: OpencodeModelFetch,
    private readonly logger: AppLogger = new AppLogger(InProcessTurnService.name),
  ) {}

  /** Persist the user turn, run the model loop, persist and stream the answer. */
  async send(input: SessionTurnInput): Promise<SessionMessage> {
    const { userId, sessionId, body, directory, agentId, correlationId } = input;
    const mode: ToolMode = body.mode ?? 'auto';
    await this.history.setAgent(sessionId, body.projectId, agentId);
    const userParent: string | null = await this.history.resolveAppendParent(sessionId, body.parentId);
    const receipt: SessionMessage = {
      id: Bun.randomUUIDv7(),
      type: 'user',
      createdAt: new Date().toISOString(),
      text: body.text,
      parentId: userParent,
    };
    // The question belongs to the durable thread before the model runs: an
    // interrupt drops the answer, never the question.
    await this.history.appendMessage({
      id: receipt.id,
      sessionId,
      userId,
      role: 'user',
      agentId,
      text: body.text,
      createdAt: receipt.createdAt,
      parentId: userParent,
    });
    await this.workspace.captureBeforeTurn(directory, sessionId, receipt.id, correlationId);
    this.state.markBusy(sessionId);
    this.state.setTurnMeta(sessionId, { userId, projectId: body.projectId, agentId, mode, receiptId: receipt.id });
    // WEB-24 / E3 cancel seam: the turn signal aborts on server-side cancel
    // (interrupt endpoint) and the boundary flag reads through
    // `shouldInterrupt` — `send` never passes `() => false`.
    const signal: AbortSignal = this.state.track(sessionId);
    const deadlineMs: number = Date.now() + TURN_TIMEOUT_MS;
    const shouldInterrupt = (): boolean => this.state.isCancelled(sessionId);
    const checkpoints: CheckpointStore = this.checkpoints();
    this.bufferStart(sessionId, receipt.id);
    const assistantId: string = Bun.randomUUIDv7();
    // Immediate durable tip of this turn: every broadcast tool row parents to
    // it (prev-link ?? receipt). The publish closure advances it synchronously
    // so the parent chain stays linked even though the DB writes queue behind.
    let chainParent: string = receipt.id;
    const seenToolIds: Set<string> = new Set<string>();
    let persistChain: Promise<void> = Promise.resolve();
    const persistToolRow = (
      toolId: string,
      name: string,
      status: string,
      text: string | null,
      detail: string | null,
      parent: string,
    ): void => {
      if (seenToolIds.has(toolId)) return;
      seenToolIds.add(toolId);
      chainParent = toolId;
      persistChain = persistChain
        .then(() =>
          this.history.appendMessage({
            id: toolId,
            sessionId,
            userId,
            role: 'tool',
            agentId,
            text,
            createdAt: new Date().toISOString(),
            parentId: parent,
            kind: 'tool',
            name,
            status,
            ...(detail !== null ? { detail } : {}),
          }),
        )
        .catch((error: unknown) => {
          this.logger.warn('[sessions] in-process tool persist failed', correlationId);
          this.logger.debug((error as Error).message, correlationId);
        });
    };
    try {
      const step: StepExecutor = this.buildStep({
        userId,
        sessionId,
        directory,
        mode,
        correlationId,
      });
      const result = await this.runner.runTurn({
        sessionId,
        directory,
        messages: [{ role: 'user', content: body.text }],
        step,
        runId: receipt.id,
        effects: new InMemoryToolEffectsStore(),
        mode,
        // Retries belong to the model router (`maxRetries: 0` on the client):
        // the runner loop must not fan a failed step out again.
        retry: { attempts: 1, delayMs: 0 },
        checkpoints,
        shouldInterrupt,
        signal,
        deadlineMs,
        publish: (frame: TurnFrame) =>
          this.publishFrame(sessionId, assistantId, receipt.id, frame, {
            userId,
            agentId,
            persistToolRow,
            getTip: (): string => chainParent,
          }),
        correlationId,
      });
      if (!this.state.isBusy(sessionId)) {
        this.logger.info('[sessions] in-process answer dropped after interrupt', correlationId);
        await persistChain;
        return receipt;
      }
      // Flush every broadcast tool row persisted by the publish closure before
      // closing the chain: max-steps/stop/interrupt never lose them, the
      // assistant only reads the tip (never extends it beyond the close).
      await persistChain;
      await this.history.appendMessage({
        id: assistantId,
        sessionId,
        userId,
        role: 'assistant',
        agentId,
        text: result.text,
        createdAt: new Date().toISOString(),
        parentId: chainParent,
      });
      this.logger.info(
        `[sessions] in-process turn done steps=${result.steps} tools=${result.settlements.length} mode=${mode}`,
        correlationId,
      );
      return receipt;
    } catch (error) {
      // Missing per-user key: the turn never started — the staged receipt is
      // discarded and the honest 404 travels outward (no host fallback).
      if (isMissingKey(error)) {
        await this.history.discardMessage(receipt.id);
        throw error;
      }
      // Postgres outage: never mask it as a model failure.
      if (error instanceof ExternalServiceError && error.service === 'db') throw error;
      // Budget breach: typed mapping with the real steps/usage — the partial
      // answer stays exactly what the live buffer already holds (never
      // invented here), the terminal frames carry only the fixed text + code.
      // Honest 409 `limit_reached` (no Retry-After): a retry with the same
      // request hits the same budget, never an upstream outage.
      if (error instanceof MaxStepsExceededError) {
        const steps: number = error.details?.steps ?? 0;
        const input: number = error.details?.usage.input ?? 0;
        const output: number = error.details?.usage.output ?? 0;
        const partialLength: number = error.details?.partialText.length ?? 0;
        this.logger.warn(
          `[sessions] in-process turn max-steps maxSteps=${error.maxSteps} steps=${steps} input=${input} output=${output} partial=${partialLength}`,
          correlationId,
        );
        this.logger.debug((error as Error).message, correlationId);
        // Flush every already-broadcast tool link before the terminal frames:
        // max-steps never loses the partial chain.
        await persistChain;
        this.bufferFailed(sessionId, 'max-steps-exceeded');
        throw new ConflictException({
          code: 'limit_reached',
          message: 'limit шагов исчерпан, продолжите с подсказкой или остановите ход',
        });
      }
      this.logger.warn('[sessions] in-process turn failed', correlationId);
      this.logger.debug((error as Error).message, correlationId);
      // Same flush-before-throw: a step throw/abort keeps its tool links.
      await persistChain;
      this.bufferFailed(sessionId, 'in-process-failed');
      if (error instanceof HttpException) throw error;
      throw fromUnknown('zen', 'sessionPromptInProcess', error);
    } finally {
      this.state.clearBusy(sessionId);
      this.state.untrack(sessionId);
      this.state.clearCancelled(sessionId);
    }
  }

  /**
   * Resume a turn parked on `awaiting_approval` (WEB-17 / C3): continues the
   * SAME checkpoint thread (`thread_id` from the parked row) without a new
   * user receipt — the durable thread below is the seed, the LangChain
   * checkpointer thread carries the model state. Checkpoint writes ride the
   * B2/C2 seam (`CheckpointStore` over `agent_checkpoints` + the
   * `shouldInterrupt` segment-boundary hook the E3 server-side cancel flips
   * alongside the turn `signal` and the `deadlineMs` wall-clock); frames ride
   * the same `publishFrame` mapping as `send` (plus `session.idle` on close).
   */
  async resume(input: {
    userId: string;
    sessionId: string;
    directory: string;
    projectId: string;
    agentId: string;
    threadId: string;
    correlationId: string;
    shouldInterrupt?: () => boolean;
  }): Promise<void> {
    const { userId, sessionId, directory, projectId, agentId, threadId, correlationId } = input;
    if (this.state.isBusy(sessionId)) {
      throw new ConflictException({
        code: 'ApprovalTurnBusy',
        message: `Session '${sessionId}' already runs a turn`,
      });
    }
    await this.history.setAgent(sessionId, projectId, agentId);
    const thread: Array<SessionMessage> = await this.history.listMessages(sessionId, projectId);
    const messages: Array<LoopMessage> = thread
      .map((message): LoopMessage | null => {
        if (message.type === 'user') return { role: 'user', content: message.text ?? '' };
        if (message.type === 'assistant') return { role: 'assistant', content: message.text ?? '' };
        if (message.type === 'tool') {
          return {
            role: 'tool',
            content: message.text ?? '',
            toolCallID: message.id,
            ...(message.name !== undefined && message.name !== null ? { toolName: message.name } : {}),
          };
        }
        if (message.type === 'reasoning') return { role: 'assistant', content: message.text ?? '' };
        return null;
      })
      .filter((message): message is LoopMessage => message !== null);
    const seed: Array<LoopMessage> =
      messages.length > 0 ? messages : [{ role: 'user', content: '' }];
    this.state.markBusy(sessionId);
    this.state.setTurnMeta(sessionId, { userId, projectId, agentId, mode: 'auto' });
    const assistantId: string = Bun.randomUUIDv7();
    const tail: string | null = await this.history.findTailId(sessionId);
    let chainParent: string = tail ?? sessionId;
    const seenToolIds: Set<string> = new Set<string>();
    let persistChain: Promise<void> = Promise.resolve();
    const persistToolRow = (
      toolId: string,
      name: string,
      status: string,
      text: string | null,
      detail: string | null,
      parent: string,
    ): void => {
      if (seenToolIds.has(toolId)) return;
      seenToolIds.add(toolId);
      chainParent = toolId;
      persistChain = persistChain
        .then(() =>
          this.history.appendMessage({
            id: toolId,
            sessionId,
            userId,
            role: 'tool',
            agentId,
            text,
            createdAt: new Date().toISOString(),
            parentId: parent,
            kind: 'tool',
            name,
            status,
            ...(detail !== null ? { detail } : {}),
          }),
        )
        .catch((error: unknown) => {
          this.logger.warn('[sessions] in-process resume tool persist failed', correlationId);
          this.logger.debug((error as Error).message, correlationId);
        });
    };
    const checkpoints: CheckpointStore = this.checkpoints();
    // WEB-24 / E3 cancel seam: the approval-time `shouldInterrupt` input and
    // the server-side cancel flag BOTH stop the turn — an abort in either
    // reads as `cancelled` on the next segment boundary.
    const callerInterrupt: (() => boolean) | undefined = input.shouldInterrupt;
    const shouldInterrupt = (): boolean =>
      callerInterrupt?.() === true || this.state.isCancelled(sessionId);
    const signal: AbortSignal = this.state.track(sessionId);
    const deadlineMs: number = Date.now() + TURN_TIMEOUT_MS;
    try {
      const step: StepExecutor = this.buildStep({
        userId,
        sessionId,
        directory,
        mode: 'auto',
        correlationId,
      });
      const result = await this.runner.runTurn({
        sessionId,
        directory,
        messages: seed,
        step,
        runId: assistantId,
        threadId,
        effects: new InMemoryToolEffectsStore(),
        mode: 'auto',
        retry: { attempts: 1, delayMs: 0 },
        checkpoints,
        shouldInterrupt,
        signal,
        deadlineMs,
        publish: (frame: TurnFrame): void =>
          this.publishFrame(sessionId, assistantId, tail ?? sessionId, frame, {
            userId,
            agentId,
            persistToolRow,
            getTip: (): string => chainParent,
          }),
        correlationId,
      });
      if (!this.state.isBusy(sessionId)) {
        this.logger.info('[sessions] in-process resume answer dropped after interrupt', correlationId);
        await persistChain;
        return;
      }
      await persistChain;
      await this.history.appendMessage({
        id: assistantId,
        sessionId,
        userId,
        role: 'assistant',
        agentId,
        text: result.text,
        createdAt: new Date().toISOString(),
        parentId: chainParent,
      });
      this.logger.info(
        `[sessions] in-process resume done steps=${result.steps} tools=${result.settlements.length} thread=${threadId}`,
        correlationId,
      );
    } catch (error) {
      if (error instanceof ExternalServiceError && error.service === 'db') throw error;
      if (error instanceof MaxStepsExceededError) {
        await persistChain;
        this.bufferFailed(sessionId, 'max-steps-exceeded');
        throw new ConflictException({
          code: 'limit_reached',
          message: 'limit шагов исчерпан, продолжите с подсказкой или остановите ход',
        });
      }
      if (error instanceof HttpException) throw error;
      this.logger.warn('[sessions] in-process resume failed', correlationId);
      this.logger.debug((error as Error).message, correlationId);
      await persistChain;
      this.bufferFailed(sessionId, 'in-process-failed');
      throw fromUnknown('zen', 'sessionPromptInProcess', error);
    } finally {
      this.state.clearBusy(sessionId);
      this.state.untrack(sessionId);
      this.state.clearCancelled(sessionId);
    }
  }

  /**
   * Durable checkpoint sink of one turn (WEB-13 / B2 seam over
   * `agentCheckpoints`): `runTurn` writes BETWEEN segments, never
   * mid-segment — shared by `send` and `resume`, no drift.
   */
  private checkpoints(): CheckpointStore {
    return {
      save: async (checkpoint): Promise<void> => {
        await this.history.saveCheckpoint({
          sessionId: checkpoint.sessionId,
          threadId: checkpoint.threadId,
          segmentIndex: checkpoint.segmentIndex,
          stepsUsed: checkpoint.stepsUsed,
          totalSteps: checkpoint.totalSteps,
          status: checkpoint.status,
          ...(checkpoint.pauseReason !== undefined ? { pauseReason: checkpoint.pauseReason } : {}),
          ...(checkpoint.state !== undefined ? { state: checkpoint.state } : {}),
          tokensUsed: checkpoint.tokensUsed,
        });
      },
    };
  }

  /**
   * Builds the model step of the turn: the registry's ToolView catalog is
   * bound to LangChain tools, filtered by mode (`ask` = read-only), and the
   * chain executor is created over the caller's per-user keys.
   *
   * Protected so a spec can answer a fake executor without a model call.
   */
  protected buildStep(input: {
    userId: string;
    sessionId: string;
    directory: string;
    mode: ToolMode;
    correlationId: string;
  }): StepExecutor {
    const views: Array<ToolView> = this.registry.listViews();
    const bindings: Array<LangChainToolBinding> = createLangChainTools(
      views,
      {
        dispatch: (calls, context, concurrency, effects) =>
          this.dispatch.dispatch(calls, context, concurrency, effects),
        context: { directory: input.directory, sessionId: input.sessionId, mode: input.mode },
      },
      { wireNameFor: nativeWireName },
    );
    const allowed: Array<LangChainToolBinding> = filterLangChainToolsForMode(
      bindings,
      input.mode,
    );
    return createStepExecutor({
      userId: input.userId,
      system: AUTO_SYSTEM_PROMPT,
      tools: allowed.map((binding) => binding.tool),
      toolChoiceFromRequest: (request) => request.toolChoice,
      keys: this.keys,
      crypto: this.crypto,
      opencodeFetch: this.opencodeFetch,
      correlationId: input.correlationId,
    });
  }

  /**
   * Start frames of the turn. `session.step.started` is emitted by the
   * runner's `step-start` publish (one per step), so it is not duplicated
   * here; the execution/reasoning markers open the live trace.
   */
  private bufferStart(sessionId: string, parentId?: string): void {
    this.buffer.push('session.execution.started', {
      sessionID: sessionId,
      ...(parentId ? { parentId } : {}),
    });
    this.buffer.push('session.reasoning.started', {
      sessionID: sessionId,
      ...(parentId ? { parentId } : {}),
    });
  }

  /**
   * Runner frame → domain SSE frame + immediate durable tool link. Live
   * frames stay guarded by the busy marker (an interrupted turn drops its
   * late frames, no phantom text/terminator), while every broadcast tool
   * frame (`tool-call` → called, `tool-result` → done/failed) persists
   * immediately as a kind=tool row parented to the tip. Idempotent by
   * broadcast id (`receipt:callID:called|result` + onConflictDoNothing +
   * tip dedupe). Detail is a redacted single-line 500-char snippet.
   */
  private publishFrame(
    sessionId: string,
    assistantId: string,
    parentId: string,
    frame: TurnFrame,
    durable?: {
      userId: string;
      agentId: string;
      persistToolRow: (
        toolId: string,
        name: string,
        status: string,
        text: string | null,
        detail: string | null,
        parent: string,
      ) => void;
      getTip: () => string;
    },
  ): void {
    if (!this.state.isBusy(sessionId)) return;
    if (frame.type === 'step-start') {
      this.buffer.push('session.step.started', { sessionID: sessionId, parentId });
      return;
    }
    if (frame.type === 'tool-call') {
      const callID: string = typeof frame.data.callID === 'string' ? frame.data.callID : '';
      const tool: string = typeof frame.data.name === 'string' ? frame.data.name : 'tool';
      this.buffer.push('session.tool.called', {
        sessionID: sessionId,
        tool,
        parentId,
        ...(callID.length > 0 ? { callID } : {}),
      });
      if (durable && callID.length > 0) {
        const toolId: string = `${parentId}:${callID}:called`;
        const detail: string | null = this.toSafeDetail(frame.data.arguments ?? null);
        durable.persistToolRow(
          toolId,
          tool,
          'called',
          typeof frame.data.arguments === 'string'
            ? frame.data.arguments.slice(0, 2000) || null
            : detail,
          detail,
          durable.getTip(),
        );
      }
      return;
    }
    if (frame.type === 'tool-result') {
      const result: string = typeof frame.data.result === 'string' ? frame.data.result : '';
      const tool: string = typeof frame.data.name === 'string' ? frame.data.name : 'tool';
      const callID: string = typeof frame.data.callID === 'string' ? frame.data.callID : '';
      const failed: boolean = result.startsWith('error:');
      this.buffer.push(failed ? 'session.tool.failed' : 'session.tool.success', {
        sessionID: sessionId,
        tool,
        parentId,
        ...(callID.length > 0 ? { callID } : {}),
        ...(failed ? { error: result } : {}),
      });
      if (durable && callID.length > 0) {
        const toolId: string = `${parentId}:${callID}:result`;
        const detail: string | null = this.toSafeDetail(result || null);
        durable.persistToolRow(
          toolId,
          tool,
          failed ? 'failed' : 'done',
          result.slice(0, 2000) || null,
          detail,
          durable.getTip(),
        );
      }
      return;
    }
    if (frame.type === 'step-finish') {
      this.buffer.push('session.step.streamed', { sessionID: sessionId, parentId });
      return;
    }
    if (frame.type === 'session.approval.requested') {
      const reason: string =
        typeof frame.data.reason === 'string' && frame.data.reason.length > 0
          ? frame.data.reason
          : 'long session needs approval';
      this.buffer.push('session.approval.requested', { sessionID: sessionId, reason, parentId });
      return;
    }
    if (frame.type === 'finish') {
      const text: string = typeof frame.data.text === 'string' ? frame.data.text : '';
      const finishReason: unknown = frame.data.finishReason;
      if (finishReason === 'awaiting_approval') {
        this.bufferTextFrames(sessionId, assistantId, parentId, text);
        this.buffer.push('session.text.ended', { sessionID: sessionId, text, parentId });
        this.buffer.push('session.approval.requested', {
          sessionID: sessionId,
          reason: 'long session needs approval',
          parentId,
        });
        return;
      }
      if (finishReason === 'cancelled') {
        // Server-side cancel only (WEB-24 / E3): the client already stopped
        // its own stream — no text tract, no `succeeded` commit, just the
        // interruption marker and the idle the send() finalizer waits on.
        this.buffer.push('session.execution.interrupted', { sessionID: sessionId, parentId });
        this.buffer.pushIdle(sessionId);
        return;
      }
      this.bufferTextFrames(sessionId, assistantId, parentId, text);
      this.buffer.push('session.text.ended', { sessionID: sessionId, text, parentId });
      this.buffer.push('session.execution.succeeded', { sessionID: sessionId, parentId });
      this.buffer.push('session.step.ended', { sessionID: sessionId, parentId });
      this.buffer.pushIdle(sessionId);
    }
  }

  /**
   * Single-line 500-char detail snippet without secrets (turns-local copy of
   * the recorder redaction: no shared util exists, no new files per CoC).
   */
  private toSafeDetail(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    const text: string =
      typeof raw === 'string' ? raw : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (text.length === 0) return null;
    const single: string = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (single.length === 0) return null;
    return single
      .replace(
        /(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer|cookie|session[_-]?id)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
        '$1=[redacted]',
      )
      .replace(
        /("(?:[^"]*(?:token|secret|password|api[_-]?key|authorization)[^"]*)"\s*:\s*")[^"]*(")/gi,
        '$1[redacted]$2',
      )
      .replace(/\bsk-[A-Za-z0-9-_]{10,}\b/g, '[redacted]')
      .replace(/\bxox[bap]-[A-Za-z0-9-]{10,}\b/g, '[redacted]')
      .replace(/\bghp_[A-Za-z0-9]{10,}\b/g, '[redacted]');
  }

  /** Chunk the assistant answer into delta frames + the absolute snapshot. */
  private bufferTextFrames(
    sessionId: string,
    assistantId: string,
    parentId: string,
    text: string,
  ): void {
    if (!text) return;
    const partID: string = `prt_${assistantId}`;
    for (let index: number = 0; index < text.length; index += SSE_CHUNK) {
      this.buffer.push('message.part.delta', {
        sessionID: sessionId,
        messageID: assistantId,
        partID,
        field: 'text',
        delta: text.slice(index, index + SSE_CHUNK),
        parentId,
      });
    }
    this.buffer.push('message.part.updated', {
      sessionID: sessionId,
      parentId,
      part: { id: partID, type: 'text', text },
    });
  }

  /** Terminal failure frames (fixed text + code, then the idempotent idle). */
  private bufferFailed(sessionId: string, code: InProcessFailedCode = 'in-process-failed'): void {
    this.buffer.push('session.execution.failed', {
      sessionID: sessionId,
      message: IN_PROCESS_FAILED_MESSAGE,
      code,
    });
    this.buffer.push('session.step.failed', {
      sessionID: sessionId,
      message: IN_PROCESS_FAILED_MESSAGE,
      code,
    });
    this.buffer.pushIdle(sessionId);
  }
}
